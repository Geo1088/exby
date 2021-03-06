#!/usr/bin/env node

'use strict';

const path = require('path');
const fs = require('fs').promises;
const util = require('util');
const yargs = require('yargs');
const rimraf = util.promisify(require('rimraf'));
const rollup = require('rollup');
const {nodeResolve} = require('@rollup/plugin-node-resolve');
const commonjs = require('@rollup/plugin-commonjs');
const babel = require('@babel/core');
const JSZip = require('jszip');

const {pathExists, forEachParallel} = require('../src/util');

(async () => {
	const argv = yargs.command('$0 <input>', false, command => command
		.positional('input', {
			desc: 'Path to a manifest.json file, or to a directory containing a manifest.json file.',
			string: true,
		})
		.option('dir', {
			desc: 'Outputs the built extension to the given directory path.',
			string: true,
		})
		.option('zip', {
			desc: 'Outputs the built extension to the given zip file.',
			string: true,
		})
		.check(options => {
			if (!options.dir && !options.zip) {
				throw new Error('At least one output option (`--dir` or `--zip`) must be specified.');
			}
			return true;
		})
		.option('cjs-exclude', {
			desc: 'Patterns to exclude from CommonJS module conversion, e.g. polyfills that need direct access to the global scope.',
			array: true,
			default: [],
		})).argv;

	// Make the manifest path into an absolute path
	let manifestPath = path.resolve(process.cwd(), argv.input);

	// If the given path is a directory, our entry point is the manifest.json inside
	const stats = await fs.stat(manifestPath);
	if (stats.isDirectory()) {
		manifestPath = path.resolve(manifestPath, 'manifest.json');
	}

	// Load the contents of the manifest
	const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));

	// We'll store a record of each entry point in this object. The key is the path as specified in the manifest, and
	// the value is an absolute path to the specified file, which Rollup uses as a module ID - we'll get back to that.
	const entryPoints = {};
	for (const contentScript of manifest.content_scripts || []) {
		for (const scriptPath of contentScript.js || []) {
			if (!entryPoints[scriptPath]) {
				entryPoints[scriptPath] = path.resolve(manifestPath, '..', scriptPath);
			}
		}
	}
	if (manifest.background) {
		for (const scriptPath of manifest.background.scripts || []) {
			if (!entryPoints[scriptPath]) {
				entryPoints[scriptPath] = path.resolve(manifestPath, '..', scriptPath);
			}
		}
	}

	// Perform code splitting on the entry points. The goal here is to flatten the dependency tree as much as possible,
	// merging individual modules that only rely on each other, getting rid of unused exports, and outputting as few
	// files as possible. For example, if the dependency tree of the input entry points looks like this:
	//
	//           a   b
	//          / \
	//     c   d   |
	//      \ /    |
	//       e     f <-- entry points
	//
	// We want to flatten it to the following tree:
	//
	//           a
	//          / \
	//     c+d+e   f
	//
	// Where e has been merged with its dependencies c and d, since it's the only thing using them, and the unused
	// dependency b has been removed entirely.
	const codeSplitBundle = await rollup.rollup({
		input: Object.values(entryPoints),
		plugins: [
			nodeResolve(),
			commonjs({
				exclude: argv.cjsExclude,
			}),
			// During this stage, we also rewrite any references to the manifest file. The contents of the manifest can
			// be read at runtime, so we do that rather than including another copy of it in the built code.
			{
				load (id) {
					// Code references to the manifest are resolved at runtime
					if (id === manifestPath) {
						return 'export default (window.browser || window.chrome).runtime.getManifest();';
					}
					// Other modules are loaded normally
					return null;
				},
			},
		],
	});
	// The output we get here is an array of "chunks," each of which corresponds to a single output file (which may
	// contain multiple input files merged together). Note that chunks which contain our entry points have a property
	// `facadeModuleId` which matches the absolute path of the entry point it contains. We still have to do some more
	// transformation to this output, but afterwards, we'll use that property to map our chunks back to the manifest.
	const {output: codeSplitOutput} = await codeSplitBundle.generate({
		format: 'es',
		sourcemap: 'inline',
	});
	await codeSplitBundle.close();

	// Once we've got our merged, code-split chunks, we need to convert them to a format our target environment can
	// understand. Firefox doesn't like ES6 modules in extension scripts, so we instead have to convert our nice
	// declarative import/export syntax into something more basic - global variable assignment. The goal is to turn a
	// module that looks like this:
	//
	//     // src/foo.js
	//     import {something} from './somewhere.js';
	//     export const somethingElse = something + 1;
	//     export const somethingDifferentEntirely = 100;
	//
	// Into source code that looks (roughly) like this:
	//
	//     // out/foo.js
	//     window.__exby_module__foo_js__ = (function () {
	//         const {something} = __exby_module__somewhere_js__;
	//         const somethingElse = something + 1;
	//         const somethingDifferentEntirely = 100;
	//         return {somethingElse, somethingDifferentEntirely};
	//     })();
	//
	// For this conversion to work, we need to give modules a place to export their values where they won't conflict
	// with anything else in the global scope, or with other modules, and where other modules that want to import their
	// values will be able to predict where to find them. We do this by creating a global variable for each module,
	//  where the variable name consists of a predictable, long prefix, along with the module's name (sanitized for use
	// in an identifier). We also need to ensure that modules exporting values are loaded before modules relying on
	// those values - this is handled below, when we rewrite the manifest. Once we've ensured these two things, we can
	// rewrite imports as global variable reads.
	const outputFiles = {};
	await forEachParallel(codeSplitOutput, async chunk => {
		if (chunk.type !== 'chunk') return;

		// Convert module imports from ES format to our IIFE-based system.
		const {code} = await babel.transformAsync(chunk.code, {
			filename: chunk.fileName,
			inputSourceMap: chunk.map,
			sourceMaps: 'inline',
			plugins: [
				[path.resolve(__dirname, '../src/babelPlugin.js'), {
					identifierPrefix: '__exby__',
				}],
			],
		});

		// Tricky part's out of the way now~! Save the final result for later.
		outputFiles[chunk.fileName] = Buffer.from(code, 'utf-8');
	});

	// All we have to do now is map each of our initial entry point files to a list of output files. We do have to be
	// careful to list dependencies first, so their exported values are ready before other files try to use them. We
	// already mapped paths in the manifest to chunk IDs earlier, so we can now go from manifest paths to a list of
	// dependencies.
	function flatImportList (chunk) {
		if (!chunk) return [];
		const nestedImports = chunk.imports.map(importee => flatImportList(codeSplitOutput.find(c => c.fileName === importee)));
		return [].concat(...nestedImports, [chunk.fileName]);
	}
	const dependencyMap = {};
	for (const [entryPath, entryModuleID] of Object.entries(entryPoints)) {
		const entryChunk = codeSplitOutput.find(chunk => chunk.facadeModuleId === entryModuleID);
		dependencyMap[entryPath] = flatImportList(entryChunk);
	}

	// Now that we have our dependency map, we need to replace the original paths in the manifest. Since we're replacing
	// each individual array value with multiple new values, we work backwards through each list of entry points. We
	// also filter each list for uniqueness once we're done, to ensure that each module is only loaded once per context,
	// even if there are multiple other modules relying on it.
	for (const contentScript of manifest.content_scripts || []) {
		if (contentScript.js) {
			for (let i = contentScript.js.length - 1; i >= 0; i -= 1) {
				contentScript.js.splice(i, 1, ...dependencyMap[contentScript.js[i]]);
			}
			contentScript.js = contentScript.js.filter((val, i, arr) => arr.indexOf(val) === i);
		}
	}
	if (manifest.background && manifest.background.scripts) {
		for (let i = manifest.background.scripts.length - 1; i >= 0; i -= 1) {
			manifest.background.scripts.splice(i, 1, ...dependencyMap[manifest.background.scripts[i]]);
		}
		manifest.background.scripts = manifest.background.scripts.filter((val, i, arr) => arr.indexOf(val) === i);
	}

	// We also have to handle assets, though this isn't too bad. We don't do any transformations on the file data like
	// we did for entry points, we just add them to our output files.
	// TODO: This code is written such that the output path could be transformed to avoid conflicts with script names,
	//       but we don't yet have a good way to perform this transformation where these paths are referenced from code.
	//       If we put all assets in an "assets" directory in the build, we have to also update all code that has those
	//       paths hardcoded to point to the subdirectory as well, and this is hard without creating a declarative
	//       import handler for non-code assets. Webpack has this for inspiration, but it's gonna be a pain. For now, we
	//       just assume that the user won't have conflicting paths or paths into the parent directory.
	await forEachParallel(Object.entries(manifest.web_accessible_resources || []), async ([i, assetPath]) => {
		const outputFilename = assetPath; // this is where we'd transform the asset path
		if (outputFiles[outputFilename] != null) {
			return;
		}
		outputFiles[outputFilename] = await fs.readFile(path.resolve(manifestPath, '..', assetPath));
		manifest.web_accessible_resources[i] = outputFilename;
	});
	await forEachParallel(Object.entries(manifest.icons || {}), async ([key, assetPath]) => {
		const outputFilename = assetPath; // this is where we'd transform the asset path
		if (outputFiles[outputFilename] != null) {
			return;
		}
		outputFiles[outputFilename] = await fs.readFile(path.resolve(manifestPath, '..', assetPath));
		manifest.icons[key] = outputFilename;
	});

	// Once we're done replacing paths, we add the revised manifest to our output.
	outputFiles['manifest.json'] = Buffer.from(JSON.stringify(manifest), 'utf-8');

	// Finally, it's time to write our output.

	// Writing to a directory
	if (argv.dir) {
		const outputDirPath = path.resolve(process.cwd(), argv.dir);
		if (await pathExists(outputDirPath)) {
			await rimraf(outputDirPath);
		}

		await fs.mkdir(outputDirPath);
		await forEachParallel(Object.entries(outputFiles), async ([filename, code]) => {
			// File names in our outputFiles object may contain subdirectories, which we have to ensure exist
			const filePath = path.resolve(outputDirPath, filename);
			await fs.mkdir(path.dirname(filePath), {recursive: true});
			await fs.writeFile(filePath, code);
		});
	}

	// Writing to a zip file
	if (argv.zip) {
		const outputZipPath = path.resolve(process.cwd(), argv.zip);
		if (await pathExists(outputZipPath)) {
			await rimraf(outputZipPath);
		}

		const zip = new JSZip();
		zip.file('manifest.json', JSON.stringify(manifest));
		for (const [filename, code] of Object.entries(outputFiles)) {
			zip.file(filename, code);
		}
		await fs.writeFile(outputZipPath, await zip.generateAsync({type: 'nodebuffer'}));
	}
})();
