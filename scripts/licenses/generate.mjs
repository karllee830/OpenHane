#!/usr/bin/env node
// 生成各端「开源许可」页面使用的第三方许可证清单。依赖变化后重新运行，并提交生成结果：
//   node scripts/licenses/generate.mjs
//
// 输出：
//   clients/web/packages/ui/src/assets/licenses.json   网页版和桌面版（含服务端 Go 依赖、npm 依赖、Electron、AI 降噪的 Rust crate）
//   clients/apple/Shared/Licenses.json                  macOS / iOS（Swift 包、WebRTC、AI 降噪的 Rust crate）
//
// 需要：Go（读取服务端依赖）、clients/web 下已执行 npm install、苹果端已执行过 swift build（读取 SwiftPM 的 checkouts），
// 以及网络（从 crates.io 下载 Rust crate 的源码包以取得许可证文件，下载结果缓存在系统临时目录）。
// 包里找不到许可证文件的组件（例如编译进 uiohook-napi 的 libuiohook）在 extra/ 下手动收录原文。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const extra = (f) => readFileSync(join(here, 'extra', f), 'utf8');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });

const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense|copyright)([-._].*)?$/i;

/** 发布包里没有许可证文件的组件：从上游仓库取来的原文（extra/packages/） */
const FALLBACK = {
  '@bufbuild/protobuf': 'bufbuild-protobuf.txt',
  'react-remove-scroll-bar': 'react-remove-scroll-bar.txt',
  realfft: 'realfft.txt',
  'lazy-val': 'lazy-val.txt',
};
const fallback = (name) => (FALLBACK[name] ? extra(`packages/${FALLBACK[name]}`) : '');

/** 读取目录下（不递归）所有许可证相关文件，按文件名排序后拼接 */
function licenseTexts(dir) {
  if (!dir || !existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
    .sort((a, b) => a.localeCompare(b))
    .map((f) => readFileSync(join(dir, f), 'utf8').trim())
    .join('\n\n');
}

/** 根据许可证正文粗略判断 SPDX 标识（Go 模块没有许可证元数据时使用） */
function classify(text) {
  const t = text.toLowerCase();
  const ids = [];
  if (t.includes('mozilla public license')) ids.push('MPL-2.0');
  else if (t.includes('gnu lesser general public')) ids.push('LGPL-3.0');
  if (t.includes('apache license') && t.includes('version 2.0')) ids.push('Apache-2.0');
  if (t.includes('permission is hereby granted, free of charge')) ids.push('MIT');
  if (t.includes('redistribution and use in source and binary forms')) ids.push(/neither the name|names of (its|the) contributors/.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause');
  if (/permission to use, copy, modify, and(\/or)? distribute/.test(t)) ids.push('ISC');
  if (t.includes('this is free and unencumbered software')) ids.push('Unlicense');
  return [...new Set(ids)].join(' AND ') || 'see text';
}

// ---------- 各类依赖 ----------

function goModules() {
  const out = run('go', ['list', '-deps', '-f', '{{if not .Standard}}{{with .Module}}{{if not .Main}}{{.Path}}\t{{.Version}}\t{{if .Replace}}{{.Replace.Dir}}{{else}}{{.Dir}}{{end}}{{end}}{{end}}{{end}}', './cmd/openhane'], join(repo, 'server'));
  const seen = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const [name, version, dir] = line.split('\t');
    if (seen.has(name)) continue;
    const text = licenseTexts(dir);
    seen.set(name, { name, version, license: classify(text), text });
  }
  return [...seen.values()];
}

function npmPackages() {
  const web = join(repo, 'clients/web');
  const dirs = run('npm', ['ls', '--omit=dev', '--all', '--parseable'], web).split('\n').filter((d) => d.includes('node_modules'));
  dirs.push(join(web, 'node_modules/electron')); // 开发依赖，但打包进桌面版
  const seen = new Map();
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (pkg.name?.startsWith('@hane/')) continue;
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) continue;
    let license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? pkg.licenses?.map((l) => l.type ?? l).join(' OR ');
    seen.set(key, { name: pkg.name, version: pkg.version, license: license || 'see text', text: licenseTexts(dir) || fallback(pkg.name) });
  }
  return [...seen.values()];
}

async function rustCrates() {
  const lock = readFileSync(join(repo, 'clients/deepfilter/Cargo.lock'), 'utf8');
  const cache = join(tmpdir(), 'openhane-license-crates');
  mkdirSync(cache, { recursive: true });
  const crates = [];
  for (const block of lock.split('[[package]]').slice(1)) {
    const name = block.match(/name = "([^"]+)"/)[1];
    const version = block.match(/version = "([^"]+)"/)[1];
    if (!block.includes('source = "registry+')) continue; // 本仓库的 crate（hane-deepfilter、libdf）单独处理
    const dir = join(cache, `${name}-${version}`);
    if (!existsSync(join(dir, 'Cargo.toml'))) {
      const res = await fetch(`https://static.crates.io/crates/${name}/${name}-${version}.crate`, { headers: { 'User-Agent': 'openhane-license-generator' } });
      if (!res.ok) throw new Error(`download ${name} ${version}: HTTP ${res.status}`);
      const file = join(cache, `${name}-${version}.crate`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      run('tar', ['-xzf', file, '-C', cache]);
    }
    const toml = readFileSync(join(dir, 'Cargo.toml'), 'utf8');
    const license = toml.match(/^license\s*=\s*"([^"]+)"/m)?.[1] ?? 'see text';
    crates.push({ name, version, license, text: licenseTexts(dir) || fallback(name) });
  }
  const libdf = join(repo, 'clients/deepfilter/libdf');
  crates.push({ name: 'DeepFilterNet (libDF and the DeepFilterNet3 model)', version: '0.5.7-pre', license: 'MIT OR Apache-2.0', text: licenseTexts(libdf) });
  return crates;
}

/** Sparkle 是 macOS 应用（Xcode 工程）的依赖，checkouts 在 Xcode 的 DerivedData 里 */
function sparkleDir() {
  const dir = [
    process.env.OPENHANE_XCODE_DERIVED,
    process.env.OPENHANE_CACHE && join(process.env.OPENHANE_CACHE, 'DerivedData'),
    join(repo, 'clients/apple/build/DerivedData-macos'),
  ]
    .filter(Boolean)
    .map((d) => join(d, 'SourcePackages/checkouts/Sparkle'))
    .find((d) => existsSync(d));
  if (!dir) throw new Error('Sparkle checkout not found: build the macOS app in Xcode first, or set OPENHANE_XCODE_DERIVED');
  return dir;
}

function sparkleVersion() {
  return readFileSync(join(repo, 'clients/apple/project.yml'), 'utf8').match(/Sparkle:[\s\S]*?exactVersion:\s*([\d.]+)/)?.[1] ?? '';
}

function swiftPackages() {
  const build = [
    process.env.OPENHANE_SPM_BUILD,
    process.env.OPENHANE_CACHE && join(process.env.OPENHANE_CACHE, 'openhanekit-build'),
    join(homedir(), 'Library/Caches/openhane/spm'),
    join(repo, 'clients/apple/Packages/OpenHaneKit/.build'),
  ].find((d) => d && existsSync(join(d, 'checkouts')));
  if (!build) throw new Error('SwiftPM checkouts not found: run swift build for clients/apple/Packages/OpenHaneKit first, or set OPENHANE_SPM_BUILD');
  const pins = JSON.parse(readFileSync(join(repo, 'clients/apple/Packages/OpenHaneKit/Package.resolved'), 'utf8')).pins;
  const version = (id) => pins.find((p) => p.identity === id)?.state.version ?? '';
  const vendor = join(repo, 'clients/apple/.vendor/client-sdk-swift');
  const sdkVersion = readFileSync(join(vendor, 'Sources/LiveKit/LiveKit.swift'), 'utf8').match(/version = "([^"]+)"/)?.[1] ?? '';
  const webrtc = join(build, 'artifacts/webrtc-xcframework/LiveKitWebRTC/LiveKitWebRTC.xcframework');
  return [
    { name: 'LiveKit Swift SDK', version: sdkVersion, license: 'Apache-2.0', text: licenseTexts(vendor) },
    { name: 'swift-protobuf', version: version('swift-protobuf'), license: 'Apache-2.0', text: licenseTexts(join(build, 'checkouts/swift-protobuf')) },
    { name: 'livekit-uniffi-xcframework', version: version('livekit-uniffi-xcframework'), license: 'Apache-2.0', text: licenseTexts(join(build, 'checkouts/livekit-uniffi-xcframework')) },
    { name: 'webrtc-xcframework', version: version('webrtc-xcframework'), license: 'MIT', text: licenseTexts(join(build, 'checkouts/webrtc-xcframework')) },
    { name: 'WebRTC', version: version('webrtc-xcframework'), license: 'BSD-3-Clause', text: licenseTexts(webrtc) },
    { name: 'Sparkle', version: sparkleVersion(), license: 'MIT', text: licenseTexts(sparkleDir()) },
  ];
}

const webExtras = () => [
  { name: 'libuiohook (in uiohook-napi)', version: '', license: 'LGPL-3.0-or-later', text: `${extra('LGPL-3.0.txt').trim()}\n\n${extra('GPL-3.0.txt').trim()}` },
  { name: 'RNNoise (in @shiguredo/rnnoise-wasm)', version: '', license: 'BSD-3-Clause', text: extra('RNNoise-COPYING.txt').trim() },
];

// ---------- 输出 ----------

/** 正文相同的组件合并成一组，减少体积；按许可证、名称排序 */
function group(components) {
  const missing = components.filter((c) => !c.text.trim());
  if (missing.length) throw new Error(`no license text found for: ${missing.map((c) => `${c.name} ${c.version}`).join(', ')}`);
  const byText = new Map();
  for (const c of components) {
    const key = c.text.replace(/\s+/g, ' ').trim();
    const g = byText.get(key) ?? { license: c.license, packages: [], text: c.text.trim() };
    g.packages.push(c.version ? `${c.name} ${c.version}` : c.name);
    byText.set(key, g);
  }
  const groups = [...byText.values()];
  for (const g of groups) g.packages.sort((a, b) => a.localeCompare(b));
  const key = (g) => g.packages[0].replace(/^@/, '').toLowerCase();
  return groups.sort((a, b) => key(a).localeCompare(key(b)));
}

function write(rel, components) {
  const groups = group(components);
  writeFileSync(join(repo, rel), `${JSON.stringify({ components: components.length, groups })}\n`);
  console.log(`${rel}: ${components.length} components, ${groups.length} license texts`);
}

const crates = await rustCrates();
write('clients/web/packages/ui/src/assets/licenses.json', [...goModules(), ...npmPackages(), ...crates, ...webExtras()]);
write('clients/apple/Shared/Licenses.json', [...swiftPackages(), ...crates]);
