import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy:        '#1e2d4d',
        'navy-light':'#2d4270',
        gold:        '#c9a84c',
        'gold-pale': '#fdf6e3',
        'gold-light':'#e8d5a0',
        cream:       '#faf7f2',
        ink:         '#2c2c2c',
        'ink-light': '#6b7280',
        'border-soft':'#e8e2d9',
        // Team colors
        'team-baby-mama': '#7c3aed',
        'team-hung':      '#0369a1',
        'team-entremet':  '#b45309',
        'team-baker':     '#047857',
        // Status colors
        'status-pending':    '#6b7280',
        'status-progress':   '#0369a1',
        'status-done':       '#047857',
        'status-skip':       '#7c3aed',
        'status-partial':    '#b45309',
        'status-blocked':    '#dc2626',
      },
      fontFamily: {
        serif: ['Playfair Display', 'Georgia', 'serif'],
        sans:  ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
