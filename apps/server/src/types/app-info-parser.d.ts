declare module 'app-info-parser' {
  export interface ApkInfo {
    package: string;
    versionName?: string;
    versionCode?: number;
    /** data:image/png;base64,... */
    icon?: string;
    application?: {
      label?: string;
      icon?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }

  export default class AppInfoParser {
    constructor(file: string | Buffer);
    parse(): Promise<ApkInfo>;
  }
}