/**
 * MJPEG 端口转发已下沉到 @adh/device-host（server 和 agent 共用）。
 */
export {
  ensureMjpegPort,
  stopMjpegForward,
  openMjpegStream,
  type MjpegStreamHandle,
} from '@adh/device-host';
