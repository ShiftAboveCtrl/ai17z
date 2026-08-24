/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: '#0C0C0C',
          raised: '#121212',
          panel: '#161616',
          line: '#232323',
        },
        bone: {
          DEFAULT: '#F2F1EE',
          dim: '#A6A49E',
          faint: '#6E6C67',
        },
        signal: {
          live: '#7BE3A3',
          wait: '#E3C87B',
          fail: '#E38A7B',
          calm: '#BBCCD7',
        },
      },
      fontFamily: {
        sans: ['Kanit', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      letterSpacing: {
        monument: '-0.045em',
      },
      maxWidth: {
        page: '84rem',
      },
      transitionTimingFunction: {
        stage: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
