#!/usr/bin/env node

import {createRequire} from 'node:module';
import {join, resolve} from 'node:path';
import {readFileSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import process from 'node:process';
import minimist from 'minimist';
import {parse, stringify} from 'yaml';
import {escapeRegExp, get} from 'lodash-es';

const require = createRequire(import.meta.url);

let {root: optRoot, config: optConfig, 'fill-gaps': optFillGaps} = minimist(process.argv);

if (!optRoot) {
	optRoot = '.';
}

const originalDir = process.cwd();

if (!optConfig) {
	optConfig = './bush.yaml';
}

const wpath = resolve(optRoot);
const configYaml = readFileSync(optConfig, 'utf8');
const config = parse(configYaml);

const rootPkg = require(join(wpath, 'package.json'));

rootPkg.name = config.name;

writeFileSync(join(wpath, 'package.json'), JSON.stringify(rootPkg, null, 2));

for await (const [wname, wnode] of Object.entries(config.workspaces)) {
	process.chdir(wpath);

	await shell`mkdir -p \\@${wname}`;

	await visitNodes({config, wname, wnode, packageNodes: wnode.tree, wpath, path: ''});
}

async function visitNodes({config, wname, wnode, packageNodes, wpath, path}) {
	for await (const [palias, packageNode] of Object.entries(packageNodes ?? {})) {
		await visitNode({config, wname, wnode, palias, packageNode, wpath, path});
	}
}

async function visitNode({config, wname, wnode, palias, packageNode, wpath, path}) {
	const apath = [path, palias].filter(Boolean).join('.');

	const packageName = wnode?.names[apath];

	const children = get(wnode?.tree, apath) ?? {};

	const refs = get(wnode?.references, apath) ?? {};

	try {
		if (packageName) {
			process.chdir(join(wpath, `@${wname}`));

			await shell`mkdir -p ${packageName}`;

			process.chdir(join(wpath, `@${wname}`, packageName));

			await shell`if [ ! -e ./package.json ]; then ${config.manager} init; fi`;

			const pkg = await require(join(wpath, `@${wname}`, packageName, 'package.json'));

			pkg.name = `@${wname}/${packageName}`;

			console.group(`[${palias}]`, ':', pkg.name);

			const [, attributes] = Object
				.entries(wnode?.attributes ?? {})
				.find(([pattern]) => {
					const regex = escapeRegExp(
						pattern
							.replace(/\*/g, '17b4b1d2-0463-5405-9f6f-b290daca08bb'),
					)
						.replace('17b4b1d2-0463-5405-9f6f-b290daca08bb', '.*');
					return new RegExp(regex, 'gim').test(apath);
				}) ?? [];

			if (attributes) {
				for await (const [ref, version] of Object.entries(attributes.references ?? {})) {
					await shell`${config.manager} install ${ref}@${version} --save`;
				}
			}

			for await (const [rpath] of Object.entries(refs)) {
				const rpackageName = wnode?.names[rpath];

				pkg.dependencies = pkg.dependencies ?? {};

				pkg.dependencies[`@${wname}/${rpackageName}`] = `${config.protocol}${`@${wname}/${rpackageName}`}`;

				console.log('->', rpath);
			}

			writeFileSync(join(wpath, `@${wname}`, packageName, 'package.json'), JSON.stringify(pkg, null, 2));
		} else if (optFillGaps) {
			if (Object.entries(children).length === 0) {
				wnode.names[apath] = '';

				writeFileSync(join(originalDir, optConfig), stringify(config, {
					nullStr: '',
				}), 'utf8');
			}
		} else {
			console.group(`[${palias}]`);
		}

		await visitNodes({config, wname, wnode, packageNodes: packageNode, wpath, path: apath});
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
