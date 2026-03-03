# 🔗 思源分享（Siyuan Share）

**思源分享（Siyuan Share）** 是一款 **免费、开源** 的思源笔记插件，用于将 **笔记本、单篇文档、文档及子文档生成可访问的分享链接**。  
它支持 **访问密码、到期时间、访客数量限制**，并提供 **访问统计概览**，适合知识分享、协作与临时公开展示等场景。

🌍 文档语言：  
[中文 README](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/README_zh_CN.md) ｜ [English README](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/README.md)

📝 使用文档：

[保姆级教程使用文档](https://share.b0x.top/s/8c34c022)

---

## 🚀 插件优势

🌐 **开箱即用，部署自由**    

本体**完全开源免费**。支持 `share.b0x.top` 快速开始，亦可私有化部署（支持 **Docker / NAS / 宝塔面板 / 其他面板**）。 

🎯 **灵活分享，精准受控**    

支持**单篇、子文档或全笔记本**分享。可**一键排除**特定文档，确保私密内容不被公开。 

⚡ **高效同步，内置统计**    

采用**增量更新**算法（省流、极速）。自带分享访问统计功能，让你对分享内容的**访客人数、地理位置等数据**了如指掌。

🔄 **自动更新，省心省力**

开启后可在后台**自动检测文档变更并更新分享页**，无需反复手动点击更新；并提供**运行状态、队列与历史记录**，让分享内容始终保持最新。

---

## ✨ 使用方法

### 📌 操作入口
在 **文档树** 中，对 **笔记本或文档** 右键点击 → 进入 **插件菜单**，可使用以下功能：

- 🆕 创建分享 / 管理分享  
- 🔄 更新分享  
- 📋 复制分享链接  
- 🗑️ 删除分享  

### 🗂️ 分享管理
进入 **插件设置页面**，即可查看 **所有已创建的分享列表**，并进行统一管理与维护。

---

## 🔐 访问设置说明

- **访问密码**  
  为分享设置访问密码，访客需输入正确密码才能查看内容。

- **到期时间**  
  超过到期时间后，分享将被标记为 **已过期**，无法访问。  
  > ⚠️ 云端数据不会自动删除，可手动清理以节省空间。

- **访客上限**  
  设置最大访客数量。  
  
  - 超出上限后，新访客将无法访问  
  - 已访问过的访客仍可继续访问  
  - 同一浏览器多次访问仅计为 **1 位访客**
  
- **链接后缀**

  自定义分享链接后缀。  

---

## ⚠️ 注意事项

- **内容更新机制**  
  
  - 若 **修改了文档或笔记本内容**，请使用 **「更新分享」**  
    → 可保持原分享链接不变，同时同步最新内容  
  - 若仅 **修改访问设置（密码 / 到期时间 / 访客上限 / 链接后缀）**，请使用 **「更新访问设置」**  
    → 无需重新上传内容，节省时间与流量
  
- **链接变动规则**  
  若执行 **「删除分享」后再「创建分享」**，  
  👉 系统将生成 **新的分享链接**，旧链接将立即失效。
  
  👉 如有需要，也可通过 **修改访问设置中的链接后缀**，将链接恢复为之前的形式。

---

## ⚙️ 插件配置说明

本插件依赖服务端网站：  
🌐 **[share.b0x.top](https://share.b0x.top)**（用于数据存储与访问）

### 1️⃣ 配置步骤

1. 前往服务端网站注册账号  
2. 在网站中生成 **API Key**  
3. 将 API Key 填入插件设置中  
4. 配置完成后，即可开始分享  
   > 分享操作本质上是将对应文档 / 笔记本上传至服务端

### 2️⃣ 服务端说明

- **公共服务说明**  
  当前的 `share.b0x.top` 为作者提供的 **公共服务端**，  
  主要用于 **功能体验与短期使用**。

- **数据清理策略**  
  受限于服务器带宽与存储成本，  
  可能会 **清理体积较大的文档或笔记本**。

- **私有化部署建议（强烈推荐）**  
  若你有 **长期分享的需求**，  
  请参考 👉 **[服务端网站搭建教程](https://ccnwc9xa9692.feishu.cn/wiki/MQCtwMtQaifPuak4zl3cIMCqnLx)**  
  自行部署私有服务端。

---

## 📖 功能演示（动图源自 GitHub，加载可能需“魔法”）

### ① 生成 API Key 并填入插件

![生成 API Key 并填入](https://github.com/user-attachments/assets/8ad5e431-8a60-4e83-a594-ff1de28af68d)

---

### ② 分享文档 / 笔记本
仅以分享笔记本为例，分享单篇文档或文档及子文档也可以

![分享笔记本](https://github.com/user-attachments/assets/62faf774-16e7-4b48-9dff-d738749ee4d5)

---

### ③ 打开分享链接查看内容

![打开分享链接](https://github.com/user-attachments/assets/155ee85c-1a73-49e4-b03e-69b9a31f2727)

---

### ④ 访问统计概览

![Access statistics](https://github.com/user-attachments/assets/b2690a03-6e97-4845-87be-1ab3e5406847)

---

## ☕ 支持作者

如果你觉得这个项目对你有帮助，欢迎支持作者 ❤️  
你的支持将激励我 **持续维护与优化**，打造更好用的工具。

<div align="center">
    <a href="https://github.com/b8l8u8e8/siyuan-plugin-share">
        <img src="https://img.shields.io/github/stars/b8l8u8e8/siyuan-plugin-share?style=for-the-badge&color=ffd700&label=%E7%BB%99%E4%B8%AAStar%E5%90%A7" alt="Github Star">
    </a>
</div>

<div align="center" style="margin-top: 40px;">
    <div style="display: flex; justify-content: center; align-items: center; gap: 30px;">
        <div style="text-align: center;">
            <img src="https://github.com/user-attachments/assets/81d0a064-b760-4e97-9c9b-bf83f6cafc8a" 
                 style="height: 280px; width: auto; border-radius: 10px; border: 2px solid #07c160;">
            <br/>
            <b style="color: #07c160; margin-top: 10px; display: block;">微信支付</b>
        </div>
        <div style="text-align: center;">
            <img src="https://github.com/user-attachments/assets/9e1988d0-4016-4b8d-9ea6-ce8ff714ee17" 
                 style="height: 280px; width: auto; border-radius: 10px; border: 2px solid #1677ff;">
            <br/>
            <b style="color: #1677ff; margin-top: 10px; display: block;">支付宝</b>
        </div>
    </div>
    <p style="margin-top: 20px;"><i>你的支持，是我持续迭代的最大动力 🙏</i></p>
</div>

---

## 🛠️ 其他信息

- 🐞 问题反馈：  
  [GitHub Issues](https://github.com/b8l8u8e8/siyuan-plugin-share/issues)

- 📄 开源协议：  
  [MIT License](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/LICENSE)

- 🧾 更新日志：  
  [CHANGELOG.md](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/CHANGELOG.md)
  
- 🏅 贡献列表：  

  [Contributors List](https://github.com/b8l8u8e8/siyuan-plugin-share/graphs/contributors)
  
- 💖 赞助列表：  
[Sponsor List](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/sponsor-list.md)

