/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // 品牌冷蓝
        brand: {
          50: "#EFF6FE",
          100: "#DCEAFD",
          300: "#8CBBF7",
          500: "#2478E8",
          600: "#1360C4",
          700: "#0B4F9E",
          800: "#083C7D",
          900: "#062B5C",
        },
        cyan: {
          100: "#CFF7FD",
          400: "#22D3EE",
          500: "#06B6D4",
          600: "#0295AC",
        },
        ink: {
          300: "#A9B5C7",
          400: "#8492A9",
          500: "#5A6B85",
          700: "#26364F",
          900: "#0C1727",
        },
        line: "#E3EAF3",
        "line-strong": "#D2DCE9",
        // 背景层
        app: "#F5F8FC",
        surface: "#FFFFFF",
        subtle: "#FAFCFE",
        sunken: "#EFF4FA",
        // 状态色
        ok: { DEFAULT: "#0EA36B", bg: "#E4F7EF" },
        warn: { DEFAULT: "#E08600", bg: "#FEF3DC" },
        err: { DEFAULT: "#E0453C", bg: "#FDEAE9" },
        info: { DEFAULT: "#1360C4", bg: "#E7F0FE" },
        idle: { DEFAULT: "#7A8AA3", bg: "#EFF2F7" },
      },
      fontFamily: {
        sans: [
          "-apple-system", "BlinkMacSystemFont", "SF Pro Display",
          "PingFang SC", "Microsoft YaHei", "Segoe UI", "Roboto", "sans-serif",
        ],
        mono: [
          "SF Mono", "JetBrains Mono", "Roboto Mono", "Menlo", "Consolas", "monospace",
        ],
      },
      borderRadius: {
        sm: "6px",
        md: "10px",
        lg: "14px",
        xl: "18px",
        "2xl": "22px",
      },
      boxShadow: {
        "sh-1": "0 1px 2px rgba(12,23,39,.04), 0 1px 3px rgba(12,23,39,.03)",
        "sh-2": "0 2px 4px rgba(12,23,39,.04), 0 8px 20px -6px rgba(12,23,39,.08)",
        "sh-3": "0 12px 40px -12px rgba(11,79,158,.22)",
        glow: "0 0 0 1px rgba(36,120,232,.14), 0 8px 28px -10px rgba(36,120,232,.38)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "pulse-ring": {
          "0%": { boxShadow: "0 0 0 0 rgba(14,163,107,.45)" },
          "70%": { boxShadow: "0 0 0 6px rgba(14,163,107,0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(14,163,107,0)" },
        },
        "flow-dash": {
          to: { strokeDashoffset: "-16" },
        },
        "shimmer": {
          "100%": { transform: "translateX(100%)" },
        },
        "rise": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "spin-slow": {
          to: { transform: "rotate(360deg)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "pulse-ring": "pulse-ring 1.8s cubic-bezier(.4,0,.6,1) infinite",
        "flow-dash": "flow-dash .7s linear infinite",
        "shimmer": "shimmer 1.6s infinite",
        "rise": "rise .5s cubic-bezier(.22,1,.36,1) both",
        "spin-slow": "spin-slow 8s linear infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}
