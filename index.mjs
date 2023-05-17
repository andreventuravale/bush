#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join, resolve} from 'node:path';
import process from 'node:process';
import minimist from 'minimist';
import {get} from 'lodash-es';
import {parse, stringify} from 'yaml';

const require = createRequire(import.meta.url);

let {root: optRoot, config: optConfig, fillGaps: optFillGaps} = minimist(process.argv);

if (!optRoot) {
	optRoot = '.';
}

if (!optConfig) {
	optConfig = './bush.yaml';
}

const wpath = resolve(optRoot);
const config = readFileSync(optConfig, 'utf8');
const json = parse(config);

const rootPkg = require(join(wpath, 'package.json'));

rootPkg.name = json.name;

writeFileSync(join(wpath, 'package.json'), JSON.stringify(rootPkg, null, 2));

for await (const [wname, wnode] of Object.entries(json.workspaces)) {
	process.chdir(wpath);

	await shell`mkdir -p \\@${wname}`;

	await visitNodes({json, wname, wnode, packageNodes: wnode.tree, wpath, path: ''});
}

async function visitNodes({json, wname, wnode, packageNodes, wpath, path}) {
	for await (const [packageDef, packageNode] of Object.entries(packageNodes ?? {})) {
		await visitNode({json, wname, wnode, packageDef, packageNode, wpath, path});
	}
}

async function visitNode({json, wname, wnode, packageDef, packageNode, wpath, path}) {
	const apath = [path, packageDef].filter(Boolean).join('.');

	const packageName = wnode?.names[apath];

	const children = get(wnode?.tree, apath) ?? {};

	const refs = get(wnode?.references, apath) ?? {};

	try {
		if (packageName) {
			process.chdir(join(wpath, `@${wname}`));

			await shell`mkdir -p ${packageName}`;

			process.chdir(join(wpath, `@${wname}`, packageName));

			await shell`if [ ! -e ./package.json ]; then ${json.manager} init; fi`;

			const pkg = await require(join(wpath, `@${wname}`, packageName, 'package.json'));

			pkg.name = `@${wname}/${packageName}`;

			console.group(`[${packageDef}]`, ':', pkg.name);

			for await (const [rpath] of Object.entries(refs)) {
				const rpackageName = wnode?.names[rpath];

				pkg.dependencies = pkg.dependencies ?? {};

				pkg.dependencies[`@${wname}/${rpackageName}`] = `${json.protocol}${`@${wname}/${rpackageName}`}`;

				console.log('->', rpath);
			}

			writeFileSync(join(wpath, `@${wname}`, packageName, 'package.json'), JSON.stringify(pkg, null, 2));
		} else if (optFillGaps) {
			if (Object.entries(children).length === 0) {
				wnode.tree.names[apath] = `# ${wnode.tree.names[apath] ?? '?'}`;

				writeFileSync(optConfig, stringify(config), 'utf8');
			}
		} else {
			console.group(`[${packageDef}]`);
		}

		await visitNodes({json, wname, wnode, packageNodes: packageNode, wpath, path: apath});
	} finally {
		console.groupEnd();
	}
}

async function shell(tpl = [], ...args) {
	const a = tpl.slice(0);
	const b = args.slice(0);
	const script = [];

	while (a.length > 0 || b.length > 0) {
		script.push(
			a.shift() ?? '',
			b.shift() ?? '',
		);
	}

	const cmd = script.join('');

	spawnSync(cmd, {cwd: process.cwd(), stdio: 'inherit', shell: true});
}
