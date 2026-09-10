import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const target = process.env.DSH_CLIENT_TARGET ?? 'local'
const output = process.env.DSH_CLIENT_OUTPUT_DIR ?? join(root, 'artifacts', target)

export default {
  appId: process.env.DSH_CLIENT_APP_ID ?? 'com.isunky.deepseek-harness.client',
  productName: 'DeepSeek Harness',
  artifactName: 'DeepSeek-Harness-${version}-${os}-${arch}.${ext}',
  directories: { output },
  electronDist: join(root, 'node_modules', 'electron', 'dist'),
  asar: true,
  asarUnpack: [
    'client/core-channel.json',
    'client/runtime/**/*',
  ],
  files: [
    'package.json',
    'client/core-channel.json',
    'client/electron/**/*',
    'client/runtime/**/*',
  ],
  extraResources: [
    ...(process.env.DSH_CLIENT_NODE_RUNTIME === undefined
      ? []
      : [
          { from: process.env.DSH_CLIENT_NODE_RUNTIME, to: 'runtime/node', filter: ['**/*'] },
          {
            from: join(process.env.DSH_CLIENT_NODE_RUNTIME, 'node_modules', 'npm'),
            to: 'runtime/node/node_modules/npm',
            filter: ['**/*'],
          },
        ]),
  ],
  extraMetadata: { main: 'client/electron/main.mjs' },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    signAndEditExecutable: false,
  },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
  mac: {
    category: 'public.app-category.productivity',
    target: [{ target: 'dmg', arch: ['x64', 'arm64'] }, { target: 'zip', arch: ['x64', 'arm64'] }],
    identity: null,
  },
  dmg: { sign: false },
  publish: null,
}
