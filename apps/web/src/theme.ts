import type { GlobalThemeOverrides } from 'naive-ui';

/**
 * shadcn/ui 浅色风格的 Naive UI 主题。
 *
 * - 背景纯白，卡片白底 + zinc-200 细边框
 * - 主按钮黑底白字（shadcn 的 primary）
 * - 文字用 zinc 色阶，几乎不用阴影
 */
export const shadcnTheme: GlobalThemeOverrides = {
  common: {
    primaryColor: '#18181b',
    primaryColorHover: '#27272a',
    primaryColorPressed: '#3f3f46',
    primaryColorSuppl: '#18181b',

    infoColor: '#2563eb',
    infoColorHover: '#3b82f6',
    infoColorPressed: '#1d4ed8',
    infoColorSuppl: '#2563eb',

    successColor: '#16a34a',
    successColorHover: '#22c55e',
    successColorPressed: '#15803d',
    successColorSuppl: '#16a34a',

    warningColor: '#d97706',
    warningColorHover: '#f59e0b',
    warningColorPressed: '#b45309',
    warningColorSuppl: '#d97706',

    errorColor: '#dc2626',
    errorColorHover: '#ef4444',
    errorColorPressed: '#b91c1c',
    errorColorSuppl: '#dc2626',

    textColorBase: '#09090b',
    textColor1: '#09090b',
    textColor2: '#52525b',
    textColor3: '#71717a',
    textColorDisabled: '#a1a1aa',
    placeholderColor: '#a1a1aa',
    placeholderColorDisabled: '#d4d4d8',

    bodyColor: '#ffffff',
    cardColor: '#ffffff',
    modalColor: '#ffffff',
    popoverColor: '#ffffff',
    tableColor: '#ffffff',
    inputColor: '#ffffff',
    actionColor: '#f4f4f5',
    tagColor: '#f4f4f5',
    avatarColor: '#e4e4e7',
    invertedColor: '#09090b',

    borderColor: '#e4e4e7',
    dividerColor: '#e4e4e7',
    hoverColor: '#f4f4f5',

    borderRadius: '6px',
    borderRadiusSmall: '4px',

    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif',
    fontFamilyMono:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',

    fontSize: '13px',
    fontSizeMini: '11px',
    fontSizeTiny: '12px',
    fontSizeSmall: '12px',
    fontSizeMedium: '13px',
    fontSizeLarge: '14px',
    fontSizeHuge: '15px',
    lineHeight: '1.55',

    heightMini: '22px',
    heightTiny: '26px',
    heightSmall: '30px',
    heightMedium: '34px',
    heightLarge: '38px',
    heightHuge: '44px',

    boxShadow1: '0 1px 2px rgba(9, 9, 11, 0.06)',
    boxShadow2: '0 4px 16px rgba(9, 9, 11, 0.08)',
    boxShadow3: '0 8px 32px rgba(9, 9, 11, 0.12)',
  },

  Layout: {
    color: '#ffffff',
    siderColor: '#fafafa',
    headerColor: '#ffffff',
    footerColor: '#ffffff',
    siderBorderColor: '#e4e4e7',
    headerBorderColor: '#e4e4e7',
  },

  Menu: {
    itemHeight: '32px',
    borderRadius: '6px',
    itemColorHover: '#f4f4f5',
    itemColorActive: '#f4f4f5',
    itemColorActiveHover: '#ebebed',
    itemTextColor: '#52525b',
    itemTextColorHover: '#09090b',
    itemTextColorActive: '#09090b',
    itemIconColor: '#71717a',
    itemIconColorHover: '#09090b',
    itemIconColorActive: '#09090b',
  },

  Button: {
    borderRadiusTiny: '4px',
    borderRadiusSmall: '5px',
    borderRadiusMedium: '6px',
    fontWeight: '500',

    color: '#ffffff',
    colorHover: '#f4f4f5',
    colorPressed: '#e4e4e7',
    colorFocus: '#f4f4f5',
    border: '1px solid #e4e4e7',
    borderHover: '1px solid #d4d4d8',
    borderPressed: '1px solid #d4d4d8',
    borderFocus: '1px solid #d4d4d8',
    textColor: '#18181b',
    textColorHover: '#09090b',
    textColorPressed: '#09090b',
    textColorFocus: '#09090b',

    colorPrimary: '#18181b',
    colorHoverPrimary: '#27272a',
    colorPressedPrimary: '#3f3f46',
    colorFocusPrimary: '#27272a',
    borderPrimary: '1px solid #18181b',
    borderHoverPrimary: '1px solid #27272a',
    borderPressedPrimary: '1px solid #3f3f46',
    borderFocusPrimary: '1px solid #27272a',
    textColorPrimary: '#fafafa',
    textColorHoverPrimary: '#fafafa',
    textColorPressedPrimary: '#fafafa',
    textColorFocusPrimary: '#fafafa',

    colorErrorText: 'transparent',
    textColorError: '#dc2626',
    textColorHoverError: '#ef4444',
    textColorPressedError: '#b91c1c',
    textColorFocusError: '#ef4444',

    colorText: 'transparent',
    colorHoverText: '#f4f4f5',
    colorPressedText: '#e4e4e7',
    colorFocusText: '#f4f4f5',
    textColorText: '#52525b',
    textColorHoverText: '#09090b',
    textColorPressedText: '#09090b',
    textColorFocusText: '#09090b',
    borderText: '1px solid transparent',
    borderHoverText: '1px solid transparent',
    borderPressedText: '1px solid transparent',
    borderFocusText: '1px solid transparent',
  },

  Input: {
    borderRadius: '6px',
    heightMedium: '34px',
    color: '#ffffff',
    colorFocus: '#ffffff',
    border: '1px solid #e4e4e7',
    borderHover: '1px solid #d4d4d8',
    borderFocus: '1px solid #a1a1aa',
    borderDisabled: '1px solid #e4e4e7',
    boxShadowFocus: '0 0 0 3px rgba(9, 9, 11, 0.08)',
    textColor: '#09090b',
    placeholderColor: '#a1a1aa',
    caretColor: '#09090b',
    iconColor: '#71717a',
    iconColorHover: '#52525b',
  },

  InternalSelection: {
    borderRadius: '6px',
    heightMedium: '34px',
    color: '#ffffff',
    colorActive: '#ffffff',
    border: '1px solid #e4e4e7',
    borderHover: '1px solid #d4d4d8',
    borderActive: '1px solid #a1a1aa',
    borderFocus: '1px solid #a1a1aa',
    boxShadowActive: '0 0 0 3px rgba(9, 9, 11, 0.08)',
    boxShadowFocus: '0 0 0 3px rgba(9, 9, 11, 0.08)',
    textColor: '#09090b',
    placeholderColor: '#a1a1aa',
    arrowColor: '#71717a',
  },

  InternalSelectMenu: {
    borderRadius: '8px',
    color: '#ffffff',
    optionTextColor: '#52525b',
    optionTextColorActive: '#09090b',
    optionColorPending: '#f4f4f5',
    optionColorActive: '#f4f4f5',
    optionColorActivePending: '#ebebed',
    optionHeightMedium: '32px',
  },

  DataTable: {
    borderRadius: '10px',
    thColor: '#fafafa',
    thColorHover: '#fafafa',
    thTextColor: '#71717a',
    thFontWeight: '500',
    tdColor: '#ffffff',
    tdColorHover: '#fafafa',
    borderColor: '#e4e4e7',
    tdTextColor: '#3f3f46',
  },

  Card: {
    borderRadius: '10px',
    color: '#ffffff',
    borderColor: '#e4e4e7',
  },

  Tag: {
    borderRadius: '4px',
    heightSmall: '20px',
    heightMedium: '22px',
    color: '#f4f4f5',
    textColor: '#52525b',
    border: '1px solid #e4e4e7',
    colorBordered: 'transparent',
    textColorBordered: '#52525b',
    borderRadiusBordered: '4px',
  },

  Drawer: {
    color: '#ffffff',
    headerColor: '#ffffff',
    footerColor: '#ffffff',
    borderColor: '#e4e4e7',
    titleTextColor: '#09090b',
    textColor: '#3f3f46',
  },

  Modal: {
    color: '#ffffff',
    borderColor: '#e4e4e7',
  },

  Dialog: {
    color: '#ffffff',
    borderRadius: '10px',
    titleTextColor: '#09090b',
    textColor: '#52525b',
  },

  Alert: {
    borderRadius: '8px',
    colorInfo: '#eff6ff',
    colorWarning: '#fffbeb',
    colorError: '#fef2f2',
    colorSuccess: '#f0fdf4',
    titleTextColorInfo: '#1d4ed8',
    titleTextColorWarning: '#b45309',
    titleTextColorError: '#b91c1c',
    titleTextColorSuccess: '#15803d',
    contentTextColorInfo: '#1e40af',
    contentTextColorWarning: '#92400e',
    contentTextColorError: '#991b1b',
    contentTextColorSuccess: '#166534',
  },

  Descriptions: {
    borderRadius: '8px',
    thColor: '#fafafa',
    tdColor: '#ffffff',
    thTextColor: '#71717a',
    tdTextColor: '#3f3f46',
    borderColor: '#e4e4e7',
  },

  Empty: {
    textColor: '#a1a1aa',
    iconColor: '#d4d4d8',
  },

  Skeleton: {
    color: '#f4f4f5',
    colorEnd: '#e4e4e7',
  },

  Tooltip: {
    color: '#18181b',
    textColor: '#fafafa',
    borderRadius: '6px',
  },

  Popover: {
    color: '#ffffff',
    borderRadius: '8px',
    textColor: '#3f3f46',
  },

  Dropdown: {
    color: '#ffffff',
    optionColorHover: '#f4f4f5',
    optionTextColor: '#52525b',
    optionTextColorHover: '#09090b',
    borderRadius: '8px',
    optionHeightMedium: '32px',
  },

  Form: {
    labelTextColor: '#52525b',
  },
};