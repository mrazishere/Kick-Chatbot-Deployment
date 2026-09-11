import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        kick: "#53FC18",
      },
    },
  },
  plugins: [],
};

export default config;
