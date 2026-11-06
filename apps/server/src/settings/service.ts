import fs from 'node:fs';
import path from 'node:path';
import type { SqlDriver } from '../db/driver.js';

export interface SiteSettings {
  /** 站点标题，空表示用默认。 */
  title: string;
  /** 站点副标题。 */
  subtitle: string;
  /** Logo 最后更新时间，0 表示没有上传。 */
  logoUpdatedAt: number;
  /** 普通用户可同时控制的设备数，0 表示不限。 */
  operatorDeviceLimit: number;
  /** 管理员可同时控制的设备数，0 表示不限（默认）。 */
  adminDeviceLimit: number;
  /** 超级管理员可同时控制的设备数，0 表示不限（默认）。 */
  superadminDeviceLimit: number;
  /** 控制者无操作自动断开的分钟数，0 表示不自动断开。 */
  idleTimeoutMinutes: number;
}

/** AI 助手使用的 OpenAI 兼容模型配置。 */
export interface AiSettings {
  enabled: boolean;
  /** 例如 https://api.deepseek.com，不带结尾斜杠。 */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  systemPrompt: string;
}

export const DEFAULT_AI_SYSTEM_PROMPT = `你是一个操作 Android / iOS 手机 UI 的专家。用户会用自然语言描述任务，你只能通过截图理解界面，并调用工具操作设备。

## 最高原则
- 纯视觉理解：只根据当前截图里可见的内容判断界面。不要假设 UI 树、DOM 或无障碍节点可用；微信小程序、Flutter、WebView、游戏等页面 UI 树经常失效，截图是唯一可靠依据。
- 用户任务写在文字消息里，截图只用于判断当前界面；不要根据截图猜测任务。
- 严格执行用户指令：只做用户要求的事，不擅自增加提交、删除、跳转、修改设置等额外操作。用户只要求中间状态（只打开、只填写、只点击）时，达到该状态就结束。

## 执行范围
- 这是自动化测试环境，用户的明确指令就是授权范围。支付、输入密码 / 验证码、删除数据、卸载应用、修改系统设置等操作都可以正常执行。
- 不要因为“高风险”自行拒绝、跳过或中断任务；只有指令含糊、目标不明确时才先说明。

## 观察与定位
- 先确认目标元素，再定位它的中心。点击文字时取文字本身，点击图标时取图标本身，输入框取可编辑区域；不要把整行或整块容器当成目标。
- 目标不在当前屏幕时，先小步滑动或滚动寻找，不要盲点、不要跳过。
- 下拉框或弹窗打开后只操作弹窗内的选项；目标不可见时小步滚动，不要一次滑太远。
- 同一文字出现多处时，结合上下文选择正确的那一个。
- 截图里被截断、缩略、半遮挡的内容可能不完整；任务依赖精确信息时，先展开或进入详情再判断。

## 坐标
- 优先使用 0~1 比例坐标，原点在左上角，屏幕中心是 (0.5, 0.5)。
- 本轮截图分辨率和右下白边会在用户消息里说明；白边不是界面内容，不要点。
- 不要按设备原始分辨率（例如 1080x2400）猜坐标。

## 动作与校验
- 每次只做最必要的下一步；动作后系统会对比前后画面。
- 如果提示“界面几乎没有变化”，不要重复同一个动作；换坐标、等待加载或先滑动。
- 输入文字前先点击输入框。输入后不要因为截图里文字被截断、顺序异常、被选中或看起来不完整就重复输入；只有输入框明显为空或页面报错时才重试。
- 输入文字后不要按 back 隐藏键盘；直接点击登录/提交按钮，或点击输入框外的空白区域。
- 输入金额、密码、验证码等纯数字/英文内容时，点击一次输入框后立刻调用 input_text（底层优先走 ADB 输入），不要用截图里的 App 数字键盘逐个点。
- 输入框已聚焦（有光标或键盘已弹出）时不要再次点击，直接 input_text；同一位置点了两次还没反应，说明没点中或不是输入框，改用 input_text 或换坐标。
- input_text 只传最终要输入的纯文本（例如 0.01 / 745488），不要传命令、转义符或分多次输入。
- 输入完成后核对输入框内容是否等于目标值；不一致时先删除（press_key BACKSPACE）再重输一次，不要连续点输入框。
- 连续两次点击同一位置且界面没有变化时，必须换策略：等待加载、滑动、检查弹窗或键盘；不要第三次点同一位置。
- 同一轮只返回必要的动作，不要一次给多个相同的点击。
- 需要保存、提交、确认、发布才算完成的操作，必须完成对应确认动作后再 done。
- 滚动或滑动方向按用户意图理解：中文“下滑页面”通常表示看下面的内容。

## 任务类型
- 操作任务（打开、点击、滑动、输入、切换、提交等）：调用工具执行。
- 观察/问答任务（看看当前页面、有没有 UI 重叠、文字是否被遮挡、这是什么界面、状态是否正常）：当前截图已有答案时不要点击或滑动，直接根据截图用中文回答。
- 查询/读取任务（例如“打开微信看一下最近一条消息”）：允许为进入目标页面做必要点击，进入后立即读取并回答；不要为了确认反复滑动或来回切换页面。
- 不确定时先描述你看到的界面，不要擅自操作。

## 应用启停
- “退出 / 关闭 / 关掉某个应用”默认指关闭应用本身，不是退出登录。优先按一次 home 回到桌面，确认目标应用已不在前台后直接 done。
- 回到桌面后不要为了“确认”再按 recent 进入最近任务；目标应用不在前台就算完成。
- 只有用户明确说“彻底关闭 / 清理后台 / 从后台移除”时，才按 recent 打开最近任务，找到目标应用的卡片上滑移除一次，随后立即 done。
- 在最近任务里移除目标卡片后，不要继续操作其他卡片、不要清理其他应用、不要反复进出最近任务。
- 最近任务里已经看不到目标应用时，视为关闭完成，不要为了确认再滑动或点击。
- “退出登录 / 退出账号”是应用内操作，和关闭应用不同；指令有歧义时优先按“关闭应用”处理，不要擅自退出账号。
- 关闭应用不需要等待保存 / 提交 / 确认弹窗，目标应用不在前台即视为完成。

## 规划
- 操作任务开始时先调用 plan，把任务拆成 2~6 个可验证的子目标；纯观察/问答任务不要调用。
- 执行过程中按计划逐步操作；计划需要调整时可以再次调用 plan。
- 每完成一个子目标，用截图确认结果，不要凭想象标记完成。
- 某个子目标无法完成时，说明原因并调用 done，不要无限重试。

## 完成
- 操作任务完成或无法继续时调用 done，用一句简短中文说明结果。
- 观察/问答任务直接输出中文回答，1~3 句；只有查询任务需要进入目标页面时才调用 tap，不要滑动。
- 需要操作时只调用工具，不要输出思考过程；不需要操作时直接回答。`;

const DEFAULT_TITLE = '设备农场';
const DEFAULT_SUBTITLE = 'Device Hub';
/** 普通用户默认只能同时控制 2 台设备。 */
const DEFAULT_OPERATOR_LIMIT = 2;
/** 管理员默认不限。 */
const DEFAULT_ADMIN_LIMIT = 0;
/** 超级管理员默认不限。 */
const DEFAULT_SUPER_LIMIT = 0;
/** 控制者默认 5 分钟无操作自动断开。 */
const DEFAULT_IDLE_TIMEOUT_MINUTES = 5;
/** 无操作超时可配置的上限。 */
export const MAX_IDLE_TIMEOUT_MINUTES = 120;

/** 站点级设置：标题和 Logo，存 adh_settings 表，Logo 文件落本地目录。 */
export class SettingsService {
  /** 控制者无操作超时的内存缓存，getSite() 时刷新，供投屏会话同步读取。 */
  private idleTimeoutMinutes = DEFAULT_IDLE_TIMEOUT_MINUTES;

  constructor(
    private readonly db: SqlDriver,
    private readonly logoDir: string,
  ) {
    fs.mkdirSync(logoDir, { recursive: true });
  }

  private logoPath(): string {
    return path.join(this.logoDir, 'logo.png');
  }

  private normalizeIdleTimeout(value: string | null): number {
    if (value === null) return DEFAULT_IDLE_TIMEOUT_MINUTES;
    const minutes = Number(value);
    if (!Number.isFinite(minutes)) return DEFAULT_IDLE_TIMEOUT_MINUTES;
    return Math.min(MAX_IDLE_TIMEOUT_MINUTES, Math.max(0, Math.floor(minutes)));
  }

  /** 控制者无操作自动断开的分钟数，0 表示不自动断开。 */
  getIdleTimeoutMinutes(): number {
    return this.idleTimeoutMinutes;
  }

  async getValue(name: string): Promise<string | null> {
    const [row] = await this.db.query<{ value: string | null }>(
      'SELECT value FROM adh_settings WHERE name = ?',
      [name],
    );
    return row?.value ?? null;
  }

  async setValue(name: string, value: string | null): Promise<void> {
    await this.db.execute('DELETE FROM adh_settings WHERE name = ?', [name]);
    await this.db.execute(
      'INSERT INTO adh_settings (name, value, updated_at) VALUES (?, ?, ?)',
      [name, value, Date.now()],
    );
  }

  async getSite(): Promise<SiteSettings> {
    const [title, subtitle, logoAt, limit, adminLimit, superLimit, idleTimeout] =
      await Promise.all([
        this.getValue('site.title'),
        this.getValue('site.subtitle'),
        this.getValue('site.logoUpdatedAt'),
        this.getValue('control.maxDevices.operator'),
        this.getValue('control.maxDevices.admin'),
        this.getValue('control.maxDevices.superadmin'),
        this.getValue('control.idleTimeoutMinutes'),
      ]);
    this.idleTimeoutMinutes = this.normalizeIdleTimeout(idleTimeout);
    return {
      title: title?.trim() || DEFAULT_TITLE,
      subtitle: subtitle?.trim() || DEFAULT_SUBTITLE,
      logoUpdatedAt: Number(logoAt ?? 0) || 0,
      operatorDeviceLimit:
        limit === null ? DEFAULT_OPERATOR_LIMIT : Math.max(0, Number(limit) || 0),
      adminDeviceLimit:
        adminLimit === null
          ? DEFAULT_ADMIN_LIMIT
          : Math.max(0, Number(adminLimit) || 0),
      superadminDeviceLimit:
        superLimit === null
          ? DEFAULT_SUPER_LIMIT
          : Math.max(0, Number(superLimit) || 0),
      idleTimeoutMinutes: this.idleTimeoutMinutes,
    };
  }

  /** OpenAI 兼容的 AI 助手配置；apiKey 仅服务端使用。 */
  async getAiSettings(): Promise<AiSettings> {
    const [enabled, baseUrl, apiKey, model, systemPrompt] = await Promise.all([
      this.getValue('ai.enabled'),
      this.getValue('ai.baseUrl'),
      this.getValue('ai.apiKey'),
      this.getValue('ai.model'),
      this.getValue('ai.systemPrompt'),
    ]);

    return {
      enabled: enabled === '1' || enabled === 'true',
      baseUrl: (baseUrl?.trim() || 'https://api.deepseek.com').replace(/\/+$/, ''),
      apiKey: apiKey?.trim() ?? '',
      model: model?.trim() || 'deepseek-flash',
      // 参考 Midscene：手机 UI 操作固定 temperature = 0，不开放给用户调
      temperature: 0,
      // 没配置或配置为空时回退到内置默认提示词
      systemPrompt: systemPrompt?.trim() || DEFAULT_AI_SYSTEM_PROMPT,
    };
  }

  /** 保存 AI 配置；apiKey 传空字符串表示不修改。 */
  async saveAiSettings(input: Partial<AiSettings>): Promise<AiSettings> {
    if (input.enabled !== undefined) {
      await this.setValue('ai.enabled', input.enabled ? '1' : '0');
    }
    if (input.baseUrl !== undefined) {
      await this.setValue('ai.baseUrl', input.baseUrl.trim() || null);
    }
    if (input.apiKey !== undefined && input.apiKey.trim()) {
      await this.setValue('ai.apiKey', input.apiKey.trim());
    }
    if (input.systemPrompt !== undefined) {
      // 清空表示恢复内置默认提示词
      await this.setValue('ai.systemPrompt', input.systemPrompt.trim() || null);
    }
    if (input.model !== undefined) {
      await this.setValue('ai.model', input.model.trim() || null);
    }
    // temperature 使用内置默认值，不接受用户覆盖
    return this.getAiSettings();
  }

  /** 按角色取同时控制上限，0 表示不限。 */
  async getDeviceLimit(role: string): Promise<number> {
    if (role === 'superadmin') {
      const value = await this.getValue('control.maxDevices.superadmin');
      return value === null
        ? DEFAULT_SUPER_LIMIT
        : Math.max(0, Number(value) || 0);
    }
    if (role === 'admin') {
      const value = await this.getValue('control.maxDevices.admin');
      return value === null ? DEFAULT_ADMIN_LIMIT : Math.max(0, Number(value) || 0);
    }
    const value = await this.getValue('control.maxDevices.operator');
    return value === null
      ? DEFAULT_OPERATOR_LIMIT
      : Math.max(0, Number(value) || 0);
  }

  async saveSite(input: {
    title: string;
    subtitle: string;
    operatorDeviceLimit?: number;
    adminDeviceLimit?: number;
    superadminDeviceLimit?: number;
    idleTimeoutMinutes?: number;
  }): Promise<SiteSettings> {
    await this.setValue('site.title', input.title.trim() || null);
    await this.setValue('site.subtitle', input.subtitle.trim() || null);
    if (input.operatorDeviceLimit !== undefined) {
      await this.setValue(
        'control.maxDevices.operator',
        String(Math.max(0, Math.floor(input.operatorDeviceLimit))),
      );
    }
    if (input.adminDeviceLimit !== undefined) {
      await this.setValue(
        'control.maxDevices.admin',
        String(Math.max(0, Math.floor(input.adminDeviceLimit))),
      );
    }
    if (input.superadminDeviceLimit !== undefined) {
      await this.setValue(
        'control.maxDevices.superadmin',
        String(Math.max(0, Math.floor(input.superadminDeviceLimit))),
      );
    }
    if (input.idleTimeoutMinutes !== undefined) {
      const minutes = Math.min(
        MAX_IDLE_TIMEOUT_MINUTES,
        Math.max(0, Math.floor(input.idleTimeoutMinutes)),
      );
      await this.setValue('control.idleTimeoutMinutes', String(minutes));
      this.idleTimeoutMinutes = minutes;
    }
    return this.getSite();
  }

  async saveTitle(title: string): Promise<SiteSettings> {
    await this.setValue('site.title', title.trim() || null);
    return this.getSite();
  }

  /** 保存 Logo 图片，返回新的更新时间。 */
  async saveLogo(data: Buffer): Promise<number> {
    fs.writeFileSync(this.logoPath(), data);
    const at = Date.now();
    await this.setValue('site.logoUpdatedAt', String(at));
    return at;
  }

  async removeLogo(): Promise<void> {
    try {
      fs.rmSync(this.logoPath(), { force: true });
    } catch {
      /* 文件可能不存在 */
    }
    await this.setValue('site.logoUpdatedAt', '0');
  }

  readLogo(): Buffer | null {
    try {
      return fs.readFileSync(this.logoPath());
    } catch {
      return null;
    }
  }
}
