import type { Theme } from "vitepress"
import DefaultTheme from "vitepress/theme"
import { h } from "vue"
import HomeExample from "./HomeExample"
import "./brand.css"
import "./home-example.css"

const theme: Theme = {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { "home-hero-after": () => h(HomeExample) }),
}

export default theme
