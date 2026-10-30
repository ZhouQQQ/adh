import type { DeviceInfo } from '@adh/protocol';

/**
 * iOS 设备发现。
 *
 * M0 返回空列表：此时只上报 agent 在线状态。
 * M1 会在这里接入 go-ios / libimobiledevice 的真实输出解析，
 * 并为每台设备附加 WDA 可达性能力标记。
 */
export async function discoverIos(): Promise<DeviceInfo[]> {
  return [];
}