/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./app/**/*.{js,jsx}', './components/**/*.{js,jsx}', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#1A1D1A',
        paper: '#F7F6F2',
        line: '#E5E2DB',
        leaf: {
          DEFAULT: '#2E5E4E',
          deep: '#22463A',
        },
        amber: {
          DEFAULT: '#C88A2D',
        },
        steel: '#6E6A61',
        mist: '#B8B3A8',
      },
      fontFamily: {
        plex: ['var(--font-plex)', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
