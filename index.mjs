#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import process from 'node:process';
import minimist from 'minimist';
import {escapeRegExp, get} from 'lodash-es';
import {parse, stringify} from 'yaml';
import yn from 'yn';

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

const jsonFile = file.bind(
	{},
	'utf8',
	raw => JSON.parse(raw),
	parsed => JSON.stringify(parsed, null, 2),
);

const rootPkg = jsonFile(
	join(wpath, 'package.json'),
);

rootPkg.content.name = config.name;

rootPkg.save();

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

			const pkgDir = join(wpath, `@${wname}`, packageName);

			const pkg = await jsonFile(
				join(pkgDir, 'package.json'),
			);

			pkg.name = `@${wname}/${packageName}`;

			console.group(`[${palias}]`, ':', pkg.name);

			const [, attributes] = Object
				.entries(wnode?.attributes ?? {})
				.find(([pattern]) => {
					const regex = escapeRegExp(
						pattern
							.replace(/\*/g, '17b4b1d2-0463-5405-9f6f-b290daca08bb')
							.replace(/\.$/g, '751e2e0a-c3ae-5258-90ab-cadb40b7a42f'),
					)
						.replace('17b4b1d2-0463-5405-9f6f-b290daca08bb', '\\\\w+')
						.replace('751e2e0a-c3ae-5258-90ab-cadb40b7a42f', '$');

					return new RegExp(regex, 'gim').test(apath);
				}) ?? [];

			if (attributes) {
				for await (const [ref, {'save-peer': savePeer}] of Object.entries(attributes.references ?? {})) {
					await shell`${
						[config.manager, 'install', `${ref}@${config.references?.[ref]?.version ?? 'latest'}`, '--save', yn(savePeer) ? '--save-peer' : '']
							.filter(Boolean)
							.join(' ')
					}`;

					pkg.invalidate();
				}
			}

			for await (const [rpath] of Object.entries(refs)) {
				const rpackageName = wnode?.names[rpath];

				pkg.dependencies = pkg.dependencies ?? {};

				pkg.dependencies[`@${wname}/${rpackageName}`] = `${config.protocol}${`@${wname}/${rpackageName}`}`;

				console.log('->', rpath);
			}
		} else if (optFillGaps) {
			if (Object.entries(children).length === 0) {
				wnode.names[apath] = '';

				writeFileSync(join(originalDir, optConfig), stringify(config, {nullStr: ''}), 'utf8');
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

	console.log('$', cmd);

	spawnSync(cmd, {cwd: process.cwd(), stdio: 'inherit', shell: true});
}

function file(options, parse, serialize, path) {
	let _content = null;

	return {
		get content() {
			if (_content === null) {
				_content = parse(readFileSync(path, options));
			}

			return _content;
		},
		invalidate() {
			_content = null;
		},
		save() {
			writeFileSync(path, serialize(_content), options);

			this.invalidate();
		},
	};
}
