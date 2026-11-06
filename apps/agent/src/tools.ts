import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TOOLS_DIR,
  ensureToolPath,
  installAndroidTools,
  installGoIos,
  probeCommandVersion,
} from '@adh/device-host';

export { TOOLS_DIR, ensureToolPath };

/** 打包时按平台放进去的内置资源（解压后无需联网）。 */
const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const VENDOR_DIR = path.join(PACKAGE_ROOT, 'vendor', process.platform);
export { VENDOR_DIR };

export interface InitOptions {
  skipAndroid?: boolean;
  skipIos?: boolean;
  force?: boolean;
}

export async function runInit(options: InitOptions = {}): Promise<void> {
  const log = (line: string): void => console.log(`  ${line}`);

  console.log(`\nadh-agent init · ${process.platform} / ${process.arch}`);
  console.log(`工具目录：${TOOLS_DIR}`);
  console.log(
    `资源来源：${fs.existsSync(VENDOR_DIR) ? '安装包内置（无需联网）' : '联网下载'}\n`,
  );

  console.log('[1/2] Android Platform Tools');
  if (options.skipAndroid) {
    console.log('  已跳过（--skip-android）');
  } else {
    const result = await installAndroidTools({
      force: Boolean(options.force),
      vendorDir: VENDOR_DIR,
      log,
    });
    if (!result.ok) {
      console.log(
        '  请手动下载：https://developer.android.com/studio/releases/platform-tools',
      );
    }
  }

  console.log('\n[2/2] go-ios（iOS 设备发现，可选）');
  if (options.skipIos) {
    console.log('  已跳过（--skip-ios）');
  } else {
    const result = await installGoIos({
      force: Boolean(options.force),
      vendorDir: VENDOR_DIR,
      log,
    });
    if (!result.ok) {
      console.log(
        '  可选：手动下载 https://github.com/danielpaulus/go-ios/releases',
      );
    }
  }

  ensureToolPath();

  console.log('\n环境检查：');
  const adb = await probeCommandVersion('adb', ['version']);
  // go-ios 的可执行文件在 Windows / macOS 上通常叫 ios.exe / ios，
  // 只认 `go-ios` 会误报「不可用」
  const goIos =
    (await probeCommandVersion('ios')) ??
    (await probeCommandVersion('go-ios'));
  console.log(`  adb    ${adb ?? '不可用'}`);
  console.log(`  go-ios ${goIos ?? '不可用（不影响 Android）'}`);

  console.log('\n下一步：');
  console.log('  adh-agent connect --server ws://<server-ip>:8080 --key adh_xxx\n');
}