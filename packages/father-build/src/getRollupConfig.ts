import { basename, extname, join } from 'path';
import { terser } from 'rollup-plugin-terser';
import babel from 'rollup-plugin-babel';
import replace from 'rollup-plugin-replace';
import json from 'rollup-plugin-json';
import nodeResolve from 'rollup-plugin-node-resolve';
import typescript from 'rollup-plugin-typescript2';
import commonjs from 'rollup-plugin-commonjs';
import postcss from 'rollup-plugin-postcss-umi';
import { ModuleFormat, RollupOptions } from 'rollup';
import { camelCase } from 'lodash';
import tempDir from 'temp-dir';
import autoprefixer from 'autoprefixer';
import NpmImport from 'less-plugin-npm-import';
import getBabelConfig from './getBabelConfig';
import { IBundleOptions } from './types';
import svgr from '@svgr/rollup';

interface IGetRollupConfigOpts {
  cwd: string;
  entry: string;
  type: ModuleFormat;
  importLibToEs?: boolean;
  bundleOpts: IBundleOptions;
}

interface IPkg {
  dependencies?: Object;
  peerDependencies?: Object;
  name?: string;
}

export default function(opts: IGetRollupConfigOpts): RollupOptions[] {
  const { type, entry, cwd, importLibToEs, bundleOpts } = opts;
  const {
    umd,
    esm,
    cjs,
    file,
    target = 'browser',
    extractCSS = false,
    cssModules: modules,
    extraPostCSSPlugins = [],
    extraBabelPresets = [],
    extraBabelPlugins = [],
    autoprefixer: autoprefixerOpts,
    namedExports,
    runtimeHelpers: runtimeHelpersOpts,
    replace: replaceOpts,
    extraExternals = [],
    nodeVersion,
    typescriptOpts,
    nodeResolveOpts = {},
  } = bundleOpts;
  const entryExt = extname(entry);
  const name = file || basename(entry, entryExt);
  const isTypeScript = entryExt === '.ts' || entryExt === '.tsx';
  const extensions = ['.js', '.jsx', '.ts', '.tsx', '.es6', '.es', '.mjs'];

  let pkg = {} as IPkg;
  try {
    pkg = require(join(cwd, 'package.json')); // eslint-disable-line
  } catch (e) {}

  // cjs 不给浏览器用，所以无需 runtimeHelpers
  const runtimeHelpers = type === 'cjs' ? false : runtimeHelpersOpts;
  const babelOpts = {
    ...getBabelConfig({
      target: type === 'esm' ? 'browser' : target,
      typescript: false,
      runtimeHelpers,
      nodeVersion,
    }),
    runtimeHelpers,
    exclude: /\/node_modules\//,
    babelrc: false,
    // ref: https://github.com/rollup/rollup-plugin-babel#usage
    extensions,
  };
  if (importLibToEs && type === 'esm') {
    babelOpts.plugins.push(require.resolve('../lib/importLibToEs'));
  }
  babelOpts.presets.push(...extraBabelPresets);
  babelOpts.plugins.push(...extraBabelPlugins);

  // rollup configs
  const input = join(cwd, entry);
  const format = type;

  // ref: https://rollupjs.org/guide/en#external
  // 潜在问题：引用包的子文件时会报 warning，比如 @babel/runtime/helpers/esm/createClass
  // 解决方案：可以用 function 处理
  const external = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.peerDependencies || {}),
    ...extraExternals,
  ];
  // umd 只要 external peerDependencies
  const externalPeerDeps = Object.keys(pkg.peerDependencies || {});

  function getPkgNameByid(id) {
    const splitted = id.split('/');
    // @ 和 @tmp 是为了兼容 umi 的逻辑
    if (id.charAt(0) === '@' && splitted[0] !== '@' && splitted[0] !== '@tmp') {
      return splitted
        .slice(0, 2)
        .join('/');
    } else {
      return id.split('/')[0];
    }
  }

  function testExternal(pkgs, id) {
    return pkgs.includes(getPkgNameByid(id));
  }

  const terserOpts = {
    compress: {
      pure_getters: true,
      unsafe: true,
      unsafe_comps: true,
      warnings: false,
    },
  };
  const plugins = [
    svgr(),
    postcss({
      extract: extractCSS,
      modules,
      use: [
        [
          'less',
          {
            plugins: [new NpmImport({ prefix: '~' })],
            javascriptEnabled: true,
          },
        ],
      ],
      plugins: [autoprefixer(autoprefixerOpts), ...extraPostCSSPlugins],
    }),
    ...(replaceOpts && Object.keys(replaceOpts || {}).length ? [replace(replaceOpts)] : []),
    nodeResolve({
      mainFields: ['module', 'jsnext:main', 'main'],
      extensions,
      ...nodeResolveOpts,
    }),
    ...(isTypeScript
      ? [
          typescript({
            // @see https://github.com/ezolenko/rollup-plugin-typescript2/issues/105
            objectHashIgnoreUnknownHack: true,
            cacheRoot: `${tempDir}/.rollup_plugin_typescript2_cache`,
            // TODO: 支持往上找 tsconfig.json
            // 比如 lerna 的场景不需要每个 package 有个 tsconfig.json
            tsconfig: join(cwd, 'tsconfig.json'),
            tsconfigDefaults: {
              compilerOptions: {
                // Generate declaration files by default
                declaration: true,
              },
            },
            tsconfigOverride: {
              compilerOptions: {
                // Support dynamic import
                target: 'esnext',
              },
            },
            ...(typescriptOpts || {}),
          }),
        ]
      : []),
    babel(babelOpts),
    json(),
  ];

  switch (type) {
    case 'esm':
      return [
        {
          input,
          output: {
            format,
            file: join(cwd, `dist/${(esm && (esm as any).file) || `${name}.esm`}.js`),
          },
          plugins: [...plugins, ...(esm && (esm as any).minify ? [terser(terserOpts)] : [])],
          external: testExternal.bind(null, external),
        },
        ...(esm && (esm as any).mjs
          ? [
              {
                input,
                output: {
                  format,
                  file: join(cwd, `dist/${(esm && (esm as any).file) || `${name}`}.mjs`),
                },
                plugins: [
                  ...plugins,
                  replace({
                    'process.env.NODE_ENV': JSON.stringify('production'),
                  }),
                  terser(terserOpts),
                ],
                external: testExternal.bind(null, externalPeerDeps),
              },
            ]
          : []),
      ];

    case 'cjs':
      return [
        {
          input,
          output: {
            format,
            file: join(cwd, `dist/${(cjs && (cjs as any).file) || name}.js`),
          },
          plugins: [...plugins, ...(cjs && (cjs as any).minify ? [terser(terserOpts)] : [])],
          external: testExternal.bind(null, external),
        },
      ];

    case 'umd':
      // Add umd related plugins
      plugins.push(
        commonjs({
          include: /node_modules/,
          namedExports,
        }),
      );

      return [
        {
          input,
          output: {
            format,
            file: join(cwd, `dist/${(umd && umd.file) || `${name}.umd`}.js`),
            globals: umd && umd.globals,
            name: (umd && umd.name) || (pkg.name && camelCase(basename(pkg.name))),
          },
          plugins: [
            ...plugins,
            replace({
              'process.env.NODE_ENV': JSON.stringify('development'),
            }),
          ],
          external: testExternal.bind(null, externalPeerDeps),
        },
        ...(umd && umd.minFile === false
          ? []
          : [
              {
                input,
                output: {
                  format,
                  file: join(cwd, `dist/${(umd && umd.file) || `${name}.umd`}.min.js`),
                  globals: umd && umd.globals,
                  name: (umd && umd.name) || (pkg.name && camelCase(basename(pkg.name))),
                },
                plugins: [
                  ...plugins,
                  replace({
                    'process.env.NODE_ENV': JSON.stringify('production'),
                  }),
                  terser(terserOpts),
                ],
                external: testExternal.bind(null, externalPeerDeps),
              },
            ]),
      ];

    default:
      throw new Error(`Unsupported type ${type}`);
  }
}
