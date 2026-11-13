import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy:        '#2A1810',   // Cacao
        'navy-light':'#572C1A',   // Brun La Paris
        gold:        '#C9A84C',
        'gold-pale': '#FBF7F0',
        'gold-light':'#E9D3A4',
        cream:       '#F6F1EA',   // Ivoire
        'cream-dark':'#EADFD0',   // Ivoire darker
        ink:         '#2E1B12',   // warm brown text
        'ink-light': '#6B7280',
        'border-soft':'#E6DCCF',  // warm border on ivory
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
        sans:  ['Be Vietnam Pro', 'Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
