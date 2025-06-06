import { TemplatePath } from "@11ty/eleventy-utils";
import debugUtil from "debug";

import TemplateLayoutPathResolver from "./TemplateLayoutPathResolver.js";
import TemplateContent from "./TemplateContent.js";
import TemplateData from "./Data/TemplateData.js";
import layoutCache from "./LayoutCache.js";

// const debug = debugUtil("Eleventy:TemplateLayout");
const debugDev = debugUtil("Dev:Eleventy:TemplateLayout");

class TemplateLayout extends TemplateContent {
	constructor(key, extensionMap, eleventyConfig) {
		if (!eleventyConfig || eleventyConfig.constructor.name !== "TemplateConfig") {
			throw new Error("Expected `eleventyConfig` in TemplateLayout constructor.");
		}

		let resolver = new TemplateLayoutPathResolver(key, extensionMap, eleventyConfig);
		let resolvedPath = resolver.getFullPath();

		super(resolvedPath, eleventyConfig);

		if (!extensionMap) {
			throw new Error("Expected `extensionMap` in TemplateLayout constructor.");
		}

		this.extensionMap = extensionMap;
		this.key = resolver.getNormalizedLayoutKey();
		this.dataKeyLayoutPath = key;
		this.inputPath = resolvedPath;
	}

	getKey() {
		return this.key;
	}

	getFullKey() {
		return TemplateLayout.resolveFullKey(this.dataKeyLayoutPath, this.inputDir);
	}

	getCacheKeys() {
		return new Set([this.dataKeyLayoutPath, this.getFullKey(), this.key]);
	}

	static resolveFullKey(key, inputDir) {
		return TemplatePath.join(inputDir, key);
	}

	static getTemplate(key, eleventyConfig, extensionMap) {
		let config = eleventyConfig.getConfig();
		if (!config.useTemplateCache) {
			return new TemplateLayout(key, extensionMap, eleventyConfig);
		}

		let inputDir = eleventyConfig.directories.input;
		let fullKey = TemplateLayout.resolveFullKey(key, inputDir);
		if (!layoutCache.has(fullKey)) {
			let layout = new TemplateLayout(key, extensionMap, eleventyConfig);

			layoutCache.add(layout);
			debugDev("Added %o to LayoutCache", key);

			return layout;
		}

		return layoutCache.get(fullKey);
	}

	async getTemplateLayoutMapEntry() {
		let { data: frontMatterData } = await this.getFrontMatterData();
		return {
			// Used by `TemplateLayout.getTemplate()`
			key: this.dataKeyLayoutPath,

			// used by `this.getData()`
			frontMatterData,
		};
	}

	async #getTemplateLayoutMap() {
		// For both the eleventy.layouts event and cyclical layout chain checking  (e.g., a => b => c => a)
		let layoutChain = new Set();
		layoutChain.add(this.inputPath);

		let cfgKey = this.config.keys.layout;
		let map = [];
		let mapEntry = await this.getTemplateLayoutMapEntry();

		map.push(mapEntry);

		while (mapEntry.frontMatterData && cfgKey in mapEntry.frontMatterData) {
			// Layout of the current layout
			let parentLayoutKey = mapEntry.frontMatterData[cfgKey];

			let layout = TemplateLayout.getTemplate(
				parentLayoutKey,
				this.eleventyConfig,
				this.extensionMap,
			);

			// Abort if a circular layout chain is detected. Otherwise, we'll time out and run out of memory.
			if (layoutChain.has(layout.inputPath)) {
				throw new Error(
					`Your layouts have a circular reference, starting at ${map[0].key}! The layout at ${layout.inputPath} was specified twice in this layout chain.`,
				);
			}

			// Keep track of this layout so we can detect duplicates in subsequent iterations
			layoutChain.add(layout.inputPath);

			// reassign for next loop
			mapEntry = await layout.getTemplateLayoutMapEntry();

			map.push(mapEntry);
		}

		this.layoutChain = Array.from(layoutChain);

		return map;
	}

	async getTemplateLayoutMap() {
		if (!this.cachedLayoutMap) {
			this.cachedLayoutMap = this.#getTemplateLayoutMap();
		}

		return this.cachedLayoutMap;
	}

	async getLayoutChain() {
		if (!Array.isArray(this.layoutChain)) {
			await this.getTemplateLayoutMap();
		}

		return this.layoutChain;
	}

	async #getData() {
		let map = await this.getTemplateLayoutMap();
		let dataToMerge = [];
		for (let j = map.length - 1; j >= 0; j--) {
			dataToMerge.push(map[j].frontMatterData);
		}

		// Deep merge of layout front matter
		let data = TemplateData.mergeDeep(this.config.dataDeepMerge, {}, ...dataToMerge);
		delete data[this.config.keys.layout];

		return data;
	}

	async getData() {
		if (!this.dataCache) {
			this.dataCache = this.#getData();
		}

		return this.dataCache;
	}

	async #getCachedCompiledLayoutFunction() {
		let rawInput = await this.getPreRender();
		return this.compile(rawInput);
	}

	// Do only cache this layout’s render function and delegate the rest to the other templates.
	async getCachedCompiledLayoutFunction() {
		if (!this.cachedCompiledLayoutFunction) {
			this.cachedCompiledLayoutFunction = this.#getCachedCompiledLayoutFunction();
		}

		return this.cachedCompiledLayoutFunction;
	}

	async getCompiledLayoutFunctions() {
		let layoutMap = await this.getTemplateLayoutMap();
		let fns = [];

		try {
			fns.push({
				render: await this.getCachedCompiledLayoutFunction(),
			});

			if (layoutMap.length > 1) {
				let [, /*currentLayout*/ parentLayout] = layoutMap;
				let { key } = parentLayout;

				let layoutTemplate = TemplateLayout.getTemplate(
					key,
					this.eleventyConfig,
					this.extensionMap,
				);

				// The parent already includes the rest of the layout chain
				let upstreamFns = await layoutTemplate.getCompiledLayoutFunctions();
				for (let j = 0, k = upstreamFns.length; j < k; j++) {
					fns.push(upstreamFns[j]);
				}
			}

			return fns;
		} catch (e) {
			debugDev("Clearing LayoutCache after error.");
			layoutCache.clear();
			throw e;
		}
	}

	async render() {
		throw new Error("Internal error: `render` was removed from TemplateLayout.js in Eleventy 3.0.");
	}

	// Inefficient? We want to compile all the templatelayouts into a single reusable callback?
	// Trouble: layouts may need data variables present downstream/upstream
	// This is called from Template->renderPageEntry
	async renderPageEntry(pageEntry) {
		let templateContent = pageEntry.templateContent;
		let compiledFunctions = await this.getCompiledLayoutFunctions();
		for (let { render } of compiledFunctions) {
			let data = {
				content: templateContent,
				...pageEntry.data,
			};

			templateContent = await render(data);
		}

		// Don’t set `templateContent` on pageEntry because collection items should not have layout markup
		return templateContent;
	}

	resetCaches(types) {
		super.resetCaches(types);
		delete this.dataCache;
		delete this.layoutChain;
		delete this.cachedLayoutMap;
		delete this.cachedCompiledLayoutFunction;
	}
}

export default TemplateLayout;
