import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy:        '#1A4731',   // Jungle
        'navy-light':'#2D6A4F',   // Jungle light
        gold:        '#C9A84C',
        'gold-pale': '#FFFAEE',
        'gold-light':'#F0D98A',
        cream:       '#FFF4CC',   // Cream Soda
        'cream-dark':'#F5E89A',   // Cream Soda darker
        ink:         '#1A2C24',   // deep green-tinted text
        'ink-light': '#6B7280',
        'border-soft':'#E0D49A',  // warm border on cream
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
