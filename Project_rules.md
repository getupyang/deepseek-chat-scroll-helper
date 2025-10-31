【Project Rules】

1. 以根目录 PRD.md 为最高优先级。
2. 只对 https://chat.deepseek.com/* 生效；开发期可加 http://localhost/* 和 file://*/*。
3. DOM 只能用 ds-message / ds-think-content / ds-markdown，禁止使用随机 hash class。
4. Shift+↑ 必须按 PRD 的上行顺序实现：Aₙ中段→Aₙ顶部→Uₙ→Uₙ₋₁→不动；Tₙ 必须滚到本轮 Uₙ。
5. Aₙ 可能不存在：此时先滚 Uₙ，再滚上一条用户，再不动并提示。
6. 当前焦点是 input / textarea / contenteditable 时不得响应快捷键。
7. 不得实现 PRD 未要求的行为（tab 回来自动滚、多站点、自定义快捷键、隐藏悬浮按钮）。
