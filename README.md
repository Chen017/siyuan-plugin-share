# 🔗 Siyuan Share

**Siyuan Share** is a **free and open-source** plugin for Siyuan Note that allows you to generate **accessible share links for notebooks, single documents, or documents with their subdocuments**.  
It supports **access passwords, expiration time, and visitor limits**, and provides an **access statistics overview**, making it suitable for knowledge sharing, collaboration, and temporary public publishing.

🌍 Documentation Languages:  
[中文 README](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/README_zh_CN.md) ｜ [English README](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/README.md)

---

## 🚀 Plugin Advantages

- **Free & Open Source, Ready to Use**  
  The plugin itself is free and open source. No additional payment is required to use the core sharing features.

- **Public Service Ready-to-Use + Optional Self-Hosting**  
  You can directly use `share.b0x.top` to get started quickly. Private deployment is also supported, including Docker deployment, NAS deployment, and deployment via BaoTa Panel or other hosting panels.

- **More Flexible Sharing Scope**  
  Supports sharing at three levels: **notebook**, **single document**, and **document with subdocuments**.

- **Incremental Updates Supported (No Full Re-upload Required)**  
  Content updates use incremental synchronization, reducing duplicate uploads for faster speed and lower bandwidth usage.

- **Support for Excluding Specific Documents**  
  You can exclude specific documents when sharing to prevent unnecessary content from being published.

- **Built-in Access Statistics Overview**  
  View share statistics including **Page Views (PV)**, **Unique Visitors (UV)**, **IP count**, and **visitor geographic distribution**, helping you evaluate sharing performance.

---

## ✨ Usage Guide

### 📌 Entry Point

In the **Document Tree**, right-click on a **notebook or document** → open the **Plugin Menu** to access the following features:

- 🆕 Create Share / Manage Share  
- 🔄 Update Share  
- 📋 Copy Share Link  
- 🗑️ Delete Share  

### 🗂️ Share Management

Go to the **Plugin Settings page** to view the **list of all created shares** and manage them centrally.

---

## 🔐 Access Settings

- **Access Password**  
  Set a password for the share. Visitors must enter the correct password to view the content.

- **Expiration Time**  
  After the expiration time, the share will be marked as **expired** and cannot be accessed.  

  > ⚠️ Cloud data will not be automatically deleted. You can manually clean it up to save storage space.

- **Visitor Limit**  
  Set the maximum number of visitors.  

  - Once the limit is reached, new visitors cannot access the share  
  - Visitors who have already accessed it can continue to visit  
  - Multiple visits from the same browser are counted as **one visitor**

- **Link Suffix**

  Customize the suffix of the share link.

---

## ⚠️ Notes

- **Content Update Mechanism**  

  - If you **modify the document or notebook content**, please use **"Update Share"**  
    → This keeps the original share link unchanged while synchronizing the latest content  
  - If you only **modify access settings (password / expiration time / visitor limit / link suffix)**, please use **"Update Access Settings"**  
    → No need to re-upload content, saving time and bandwidth

- **Link Change Rules**  
  If you **"Delete Share" and then "Create Share" again**,  
  👉 The system will generate a **new share link**, and the old link will immediately become invalid.

  👉 If needed, you can restore the previous link format by modifying the **link suffix** in the access settings.

---

## ⚙️ Plugin Configuration

This plugin relies on a server-side website:  
🌐 **[share.b0x.top](https://share.b0x.top)** (used for data storage and access)

### 1️⃣ Setup Steps

1. Register an account on the server website  

2. Generate an **API Key** on the website  

3. Enter the API Key into the plugin settings  

4. After configuration, you can start sharing  

   > Sharing essentially uploads the corresponding document or notebook to the server

### 2️⃣ Server Information

- **Public Service**  
  The current `share.b0x.top` is a **public server provided by the author**,  
  mainly intended for **feature experience and short-term use**.

- **Data Cleanup Policy**  
  Due to bandwidth and storage limitations,  
  large documents or notebooks **may be cleaned up** periodically.

- **Private Deployment Recommendation (Strongly Recommended)**  
  If you need **long-term sharing**,  
  please refer to 👉 **[Server Deployment Guide](https://ccnwc9xa9692.feishu.cn/wiki/MQCtwMtQaifPuak4zl3cIMCqnLx)**  
  to deploy your own private server.

---

## 📖 Feature Demonstration (GIFs hosted on GitHub, may require proxy access)

### ① Generate API Key and Enter It into the Plugin

![Generate API Key](https://github.com/user-attachments/assets/8ad5e431-8a60-4e83-a594-ff1de28af68d)

---

### ② Share Document / Notebook

Using notebook sharing as an example. Single document or document with subdocuments sharing is also supported.

![Share Notebook](https://github.com/user-attachments/assets/62faf774-16e7-4b48-9dff-d738749ee4d5)

---

### ③ Open the Share Link to View Content

![Open Share Link](https://github.com/user-attachments/assets/155ee85c-1a73-49e4-b03e-69b9a31f2727)

---

### ④ Access Statistics Overview

![Access statistics](https://github.com/user-attachments/assets/b2690a03-6e97-4845-87be-1ab3e5406847)

---

## ☕ Support the Author

If you find this project helpful, feel free to support the author ❤️  
Your support motivates me to **continuously maintain and improve** this tool.

<div align="center">
    <a href="https://github.com/b8l8u8e8/siyuan-plugin-share">
        <img src="https://img.shields.io/github/stars/b8l8u8e8/siyuan-plugin-share?style=for-the-badge&color=ffd700&label=Give%20a%20Star" alt="Github Star">
    </a>
</div>

<div align="center" style="margin-top: 40px;">
    <div style="display: flex; justify-content: center; align-items: center; gap: 30px;">
        <div style="text-align: center;">
            <img src="https://github.com/user-attachments/assets/81d0a064-b760-4e97-9c9b-bf83f6cafc8a" 
                 style="height: 280px; width: auto; border-radius: 10px; border: 2px solid #07c160;">
            <br/>
            <b style="color: #07c160; margin-top: 10px; display: block;">WeChat Pay</b>
        </div>
        <div style="text-align: center;">
            <img src="https://github.com/user-attachments/assets/9e1988d0-4016-4b8d-9ea6-ce8ff714ee17" 
                 style="height: 280px; width: auto; border-radius: 10px; border: 2px solid #1677ff;">
            <br/>
            <b style="color: #1677ff; margin-top: 10px; display: block;">Alipay</b>
        </div>
    </div>
    <p style="margin-top: 20px;"><i>Your support is the greatest motivation for continuous iteration 🙏</i></p>
</div>

---

## 🛠️ Other Information

- 🐞 Issue Reporting:  
  [GitHub Issues](https://github.com/b8l8u8e8/siyuan-plugin-share/issues)

- 📄 License:  
  [MIT License](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/LICENSE)

- 🧾 Changelog:  
  [CHANGELOG.md](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/CHANGELOG.md)

- 🏅 Contributors:  
  [Contributors List](https://github.com/b8l8u8e8/siyuan-plugin-share/graphs/contributors)

- 💖 Sponsors:  
  [Sponsor List](https://github.com/b8l8u8e8/siyuan-plugin-share/blob/main/sponsor-list.md)
