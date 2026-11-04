/**
 * WDA HTTP 封装已下沉到 @adh/device-host（server 和 agent 共用）。
 * 这里保留原路径，避免调用方大改。
 */
export {
  wdaAppSwitcher,
  wdaApplyMjpegSettings,
  wdaLock,
  wdaPinch,
  wdaPressButton,
  wdaScreenshot,
  wdaStatus,
  wdaSwipe,
  wdaTap,
  wdaTypeText,
  wdaUnlock,
  wdaWindow,
  type WdaButton,
} from '@adh/device-host';
