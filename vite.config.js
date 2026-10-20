import { defineConfig } from 'vite';

// GitHub Pages(프로젝트 페이지)는 https://<user>.github.io/general-toe/ 아래에 뜨므로 base가 필요하다.
// 로컬 dev는 '/'.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/general-toe/' : '/',
}));
