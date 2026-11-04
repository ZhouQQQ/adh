/// <reference types="vite/client" />

/** 构建时注入：版本号与构建时间（见 vite.config.ts 的 define）。 */
declare const __ADH_VERSION__: string;
declare const __ADH_BUILD_TIME__: string;

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
