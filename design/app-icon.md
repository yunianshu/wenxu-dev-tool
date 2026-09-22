# 应用图标：项目启航

适用产品：Personnel PLM。设计采用项目文件夹与向右上方的发布箭头，表达围绕项目组织开发工作并发布成果。青绿色延续界面主色，浅色主体和金色箭头强化小尺寸辨识；不依赖文字或细节。

- 工具：内置 `image_gen`，生成一张全新图像；未使用 API/CLI 回退。
- 源图：`build/icon-source.png`，1254×1254，不透明正方形。
- 应用图：`build/icon.png`，1024×1024。
- Windows 图标：`build/icon.ico`，包含 256、128、64、48、32、24、16 像素档位。
- 生成与校验：`npm run gen:icons`、`npm run verify:icons`。完整保留构图，只做尺寸转换；不使用历史去底脚本。
- 接入：侧栏、窗口、托盘和 favicon 继续引用现有 PNG；Windows 打包钩子继续注入 ICO。已安装版本在下次构建安装后更新。

## 原始生成提示

```text
Use case: logo-brand. Asset type: final desktop application icon for Personnel PLM, a project-centered developer workspace combining project management, AI assistance, Git activity and one-click production deployment. Create one original polished square icon, not a presentation board. Visual concept: one unmistakable bold cream-white project-folder silhouette with a wide upward-right launch arrow integrated into its open upper-right corner, an intelligent cohesive geometric mark rather than several pictograms. The folder has a single offset jade-green backing card visible above its left shoulder; the arrow is warm amber-gold, with a thick simple shaft and arrowhead. The main folder body is substantial and rounded, its lower left corner gently curved, open negative space between folder and arrow; icon mark fills about 68% of the canvas and is optically centered. Background is a full-bleed completely opaque solid deep teal #0E7A6D covering the entire 1:1 square all the way to all four corners. Crisp simple shapes, meticulous balance and generous clean margins. Premium restrained developer-tool identity, gently softened geometric corners, nearly flat with only an extremely subtle dimensional edge, no texture or noise. Strong contrast and very broad silhouettes remain legible at 16px, 24px and 32px. No text, no letters, no wordmark, no border, no surrounding mockup, no shadows outside the mark, no gradients, no glow, no mascot, no tiny details, no sparkles, no watermark. Output only the single finished square app icon, ideally 1024x1024.
```
