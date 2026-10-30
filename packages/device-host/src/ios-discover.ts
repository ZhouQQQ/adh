import type { DeviceInfo } from '@adh/protocol';

/**
 * iOS 设备发现。
 *
 * 当前返回空列表；M1b 会接入 go-ios / libimobiledevice 的真实输出解析，
 * 并为每台设备附加 WDA 可达性能力标记。
 */
export async function discoverIos(): Promise<DeviceInfo[]> {
  return [];
}