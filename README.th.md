<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README.zh.md">简体中文</a> |
  <a href="./README.zht.md">繁體中文</a> |
  <a href="./README.ko.md">한국어</a> |
  <a href="./README.de.md">Deutsch</a> |
  <a href="./README.es.md">Español</a> |
  <a href="./README.fr.md">Français</a> |
  <a href="./README.it.md">Italiano</a> |
  <a href="./README.da.md">Dansk</a> |
  <a href="./README.ja.md">日本語</a> |
  <a href="./README.pl.md">Polski</a> |
  <a href="./README.ru.md">Русский</a> |
  <a href="./README.bs.md">Bosanski</a> |
  <a href="./README.ar.md">العربية</a> |
  <a href="./README.no.md">Norsk</a> |
  <a href="./README.br.md">Português (Brasil)</a> |
  <strong>ไทย</strong> |
  <a href="./README.tr.md">Türkçe</a> |
  <a href="./README.uk.md">Українська</a> |
  <a href="./README.bn.md">বাংলা</a> |
  <a href="./README.gr.md">Ελληνικά</a> |
  <a href="./README.vi.md">Tiếng Việt</a>
</p>

*นี่คือคำแปลจากชุมชน ไฟล์ [README.md](./README.md) ภาษาอังกฤษเป็นแหล่งอ้างอิงหลักและอาจอัปเดตกว่า*

<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>บริบทไร้ขอบเขต หน่วยความจำที่จัดการตัวเอง หนึ่งเซสชันสำหรับทั้งชีวิต.</strong><br>
  ฮิปโปแคมปัสสำหรับเอเจนต์เขียนโค้ด และเป็นส่วนหนึ่งของ CortexKit.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@cortexkit/magic-context"><img src="https://img.shields.io/npm/v/@cortexkit/magic-context?label=cli&color=orange&style=flat-square" alt="npm @cortexkit/magic-context"></a>
  <a href="https://www.npmjs.com/package/@cortexkit/opencode-magic-context"><img src="https://img.shields.io/npm/v/@cortexkit/opencode-magic-context?label=opencode&color=blue&style=flat-square" alt="npm @cortexkit/opencode-magic-context"></a>
  <a href="https://www.npmjs.com/package/@cortexkit/pi-magic-context"><img src="https://img.shields.io/npm/v/@cortexkit/pi-magic-context?label=pi&color=purple&style=flat-square" alt="npm @cortexkit/pi-magic-context"></a>
  <a href="https://discord.gg/DSa65w8wuf"><img src="https://img.shields.io/discord/1488852091056295957?style=flat-square&logo=discord&logoColor=white&label=Discord&color=5865F2" alt="Discord"></a>
  <a href="https://github.com/cortexkit/magic-context/stargazers"><img src="https://img.shields.io/github/stars/cortexkit/magic-context?style=flat-square&color=yellow" alt="stars"></a>
  <a href="https://github.com/cortexkit/magic-context/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License"></a>
</p>

<p align="center">
  <em>คุณไม่ได้จ้างนักพัฒนามาทำงานเดียว แล้วไล่ออกทันทีที่ส่งงาน.<br>อย่าทำแบบนั้นกับเอเจนต์ของคุณ.</em>
</p>

<p align="center">
  <a href="#magic-context-คืออะไร">Magic Context คืออะไร?</a> ·
  <a href="#เริ่มต้นอย่างรวดเร็ว">เริ่มต้นอย่างรวดเร็ว</a> ·
  <a href="#ส่วนหนึ่งของ-cortexkit">CortexKit</a> ·
  <a href="#การจัดการบริบท">บริบท</a> ·
  <a href="#การจับข้อมูล">การจับข้อมูล</a> ·
  <a href="#การรวบรวมความจำ">การรวบรวมความจำ</a> ·
  <a href="#การเรียกคืน">การเรียกคืน</a> ·
  <a href="https://docs.cortexkit.io/magic-context">Docs</a> ·
  <a href="./CONFIGURATION.md">Configuration</a> ·
  <a href="https://github.com/cortexkit/magic-context/releases?q=dashboard&expanded=true">Dashboard</a> ·
  <a href="https://discord.gg/DSa65w8wuf">💬 Discord</a>
</p>

---

## Magic Context คืออะไร?

คุณไม่ได้จ้างนักพัฒนาเพื่อแก้ bug เดียวแล้วไล่ออกทันทีที่ปล่อยงาน คนเก่งคุณจะเก็บไว้ พวกเขาเรียนรู้ codebase จำได้ว่าการตัดสินใจเกิดขึ้นเพราะอะไร และคมขึ้นทุกสัปดาห์.

เอเจนต์เขียนโค้ดทำงานตรงกันข้าม ทุกงานเหมือนการจ้างคนใหม่ที่ไม่มีความจำเกี่ยวกับโปรเจกต์ของคุณ และเมื่อจบแต่ละเซสชันคุณก็ไล่ออกแล้วเริ่มจากศูนย์ กลางงานพวกเขายังเจอการหยุด "compaction" ที่ทำลายจังหวะและทำให้สิ่งที่รู้หายไปอย่างเงียบ ๆ นี่คือภาวะลืมแบบ anterograde เช่นเดียวกับเมื่อฮิปโปแคมปัสเสียหาย.

Magic Context มอบสิ่งนั้นให้พวกเขา มันคือ **ฮิปโปแคมปัส** สำหรับเอเจนต์เขียนโค้ด ส่วนของสมองที่สร้างความจำ รวบรวมความจำ และเรียกคืนความจำ ทั้งหมดเกิดขึ้นในพื้นหลัง เซสชันหนึ่งจึงไม่ใช่ผู้รับเหมาชั่วคราวอีกต่อไป แต่เป็นเพื่อนร่วมทีมระยะยาวที่อยู่กับทั้งโปรเจกต์:

- **การจับข้อมูล.** เมื่อ historian บีบอัดประวัติของคุณ มันยกความรู้ที่คงทน (การตัดสินใจ ข้อจำกัด ข้อตกลง) เข้าไปในหน่วยความจำของโปรเจกต์ คุณได้ระบบความจำฟรีจากงานที่คุณทำอยู่แล้ว.
- **การรวบรวมความจำ.** ตอนกลางคืน เอเจนต์ dreamer ทำสิ่งที่การนอนทำให้คุณ: ตรวจสอบความจำกับ codebase จัดการรายการซ้ำและเก่า และยกระดับสิ่งที่เกิดซ้ำ.
- **การเรียกคืน.** ความจำที่ถูกต้องจะปรากฏอัตโนมัติทุกเทิร์น และเอเจนต์สามารถค้นหาในความจำ บทสนทนาเก่า และประวัติ git ตามต้องการ ข้ามเซสชัน และข้าม OpenCode กับ Pi.

คำสัญญาสองข้อ: เอเจนต์ของคุณ **ไม่เคยหยุดเพื่อจัดการบริบทของตัวเอง** (ไม่มีการหยุด compaction ไม่มีจังหวะที่ขาด) และมัน **ไม่เคยลืม**.

รันหนึ่งเซสชันต่อโปรเจกต์และปล่อยให้ดำเนินต่อไปเป็นสัปดาห์ เดือน หรือปี มันจะจำทุกอย่างที่คุณสร้างร่วมกัน.

---

## เริ่มต้นอย่างรวดเร็ว

รันตัวช่วยตั้งค่าแบบโต้ตอบ มันตรวจพบโมเดลของคุณ กำหนดค่าทุกอย่าง และจัดการความเข้ากันได้.

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex
```

**หรือรันโดยตรง (ทุก OS):**
```bash
npx @cortexkit/magic-context@latest setup
```

ตัวช่วยจะตรวจหา harnesses ที่คุณมีโดยอัตโนมัติ (OpenCode, Pi หรือทั้งคู่) เพิ่ม plugin ปิด compaction ในตัว ช่วยเลือกโมเดลสำหรับ historian และ dreamer และแก้ความขัดแย้งกับ plugins จัดการบริบทอื่น ๆ ระบุ harness เฉพาะได้ด้วย `--harness opencode` หรือ `--harness pi`.

> **ทำไมต้องปิด compaction ในตัว?** Magic Context จัดการบริบทเอง compaction ของโฮสต์จะรบกวนงานที่เลื่อนเวลาและรับรู้ cache ของมัน และจะบีบอัดซ้ำสองครั้ง.

**ตั้งค่าด้วยตนเอง** (OpenCode): เพิ่ม plugin และปิด compaction ใน `opencode.json` จากนั้นวาง `magic-context.jsonc` ใน `<project>/.cortexkit/` (หรือ `~/.config/cortexkit/` สำหรับค่าเริ่มต้นระดับผู้ใช้) ดู [คู่มือการกำหนดค่า](./CONFIGURATION.md).

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": { "auto": false, "prune": false }
}
```

**Pi:** `npx @cortexkit/magic-context@latest setup --harness pi` (ต้องใช้ Pi `>= 0.74.0`) ส่วนขยาย Pi ใช้ฐานข้อมูลเดียวกับ OpenCode ความจำของโปรเจกต์และ embeddings จะรวมกันระหว่างทั้งสอง.

**การแก้ปัญหา:** `npx @cortexkit/magic-context@latest doctor` ตรวจหา harnesses ของคุณ ตรวจความขัดแย้ง (compaction, OMO hooks, DCP) ตรวจสอบ plugin และแถบข้าง TUI รันการตรวจความสมบูรณ์ของฐานข้อมูล และแก้สิ่งที่แก้ได้ เพิ่ม `--issue` เพื่อสร้างรายงาน bug ที่พร้อมส่ง.

ทำงานเหมือนกันทั้งโปรเจกต์ใหม่และโปรเจกต์ที่รันมานาน: ติดตั้ง รีสตาร์ท harness แล้ว Magic Context จะจับบริบทจากจุดนั้นไปข้างหน้า มันจะไม่เติมย้อนหลังให้เซสชัน OpenCode หรือ Pi ก่อนติดตั้ง.

<details>
<summary><strong>ความเข้ากันได้กับ plugins จัดการบริบทอื่น</strong></summary>

<br>

Magic Context เป็นเจ้าของการจัดการบริบทตั้งแต่ต้นจนจบ ดังนั้นมันจะ **ปิดตัวเอง** หาก plugin อื่นทำงานนั้นอยู่แล้ว การรันตัวจัดการบริบทสองตัวพร้อมกันจะบีบอัดประวัติซ้ำและทำให้ prompt cache สั่นไหว ตอนเริ่มต้นมันตรวจสิ่งต่อไปนี้; setup และ `doctor` ช่วยคุณแก้แต่ละข้อ และจนกว่าจะแก้เสร็จ Magic Context จะปิดอยู่ (fail-safe) และบอกเหตุผล:

- **OpenCode built-in compaction** (`compaction.auto` / `compaction.prune`): Magic Context แทนที่มัน Setup จะปิดให้.
- **DCP** (`opencode-dcp`): plugin แยกสำหรับตัดบริบท ทั้งสองรันร่วมกันไม่ได้ ให้ลบออกจากรายการ `plugin`.
- **oh-my-opencode (OMO)**: setup เสนอให้ปิด hooks สามตัวที่ทับซ้อน:
  - `preemptive-compaction`: เรียก compaction ที่ขัดกับ historian.
  - `context-window-monitor`: แทรกคำเตือนการใช้งานที่ทับกับ nudges ของ Magic Context.
  - `anthropic-context-window-limit-recovery`: เรียก compaction ฉุกเฉินที่ข้าม historian.

รัน `npx @cortexkit/magic-context@latest doctor` ได้ทุกเมื่อเพื่อตรวจซ้ำและแก้อัตโนมัติ.

</details>

---

## ส่วนหนึ่งของ CortexKit

สมองไม่ได้เป็นอวัยวะเดียว เอเจนต์เขียนโค้ดที่มีความสามารถก็เช่นกัน.

**CortexKit** คือครอบครัวของ plugins แต่ละตัวจำลองจากบริเวณต่าง ๆ ของสมอง ติดตั้งหนึ่งตัว เอเจนต์ของคุณจะคมขึ้น ติดตั้งทั้งสามตัว มันจะมีสมอง.

| Plugin | บริเวณ | สิ่งที่ทำ |
|---|---|---|
| **Magic Context** *(คุณอยู่ที่นี่)* | ฮิปโปแคมปัสและกลีบขมับด้านใน | บริบทที่จัดการตัวเองและความจำระยะยาว ทำให้เซสชันรันต่อโดยไม่มีการหยุด compaction ขณะสร้าง รวบรวม และเรียกคืนความรู้ของโปรเจกต์ข้ามเซสชัน. |
| **[AFT](https://github.com/cortexkit/aft)** | คอร์เทกซ์รับความรู้สึกและสั่งการ | รับรู้โครงสร้างโค้ดและทำงานกับมันอย่างแม่นยำ IDE และ OS ที่เหมาะสมสำหรับเอเจนต์ของคุณ. |
| **Alfonso** *(เร็ว ๆ นี้)* | คอร์เทกซ์ส่วนหน้า | การควบคุมเชิงบริหาร วางแผน แยกงาน เลือกเอเจนต์และโมเดล และตัดสินใจว่าจะถาม ตรวจสอบ และ commit เมื่อไร. |

Magic Context คือ **1 ใน 3 plugins ที่คุณจะต้องใช้เสมอ.** มันจำ; AFT รับรู้และลงมือ; Alfonso ตัดสินใจ ทั้งหมดใช้ CortexKit store เดียวกัน ความจำจึงรวมกันข้าม harnesses และเครื่องมือ.

---

## ⚡ การจัดการบริบท

*เซสชันไร้ขอบเขตที่จัดการตัวเอง.* หน้าต่างบริบทเต็มขึ้นเมื่อคุณทำงาน และวิธีแก้ทั่วไปคือ compaction ซึ่งหยุดเอเจนต์ทันทีเพื่ออ่านทุกอย่างใหม่ Magic Context จัดการต่อเนื่องในพื้นหลัง เซสชันจึงเดินหน้าต่อ.

- **การแบ่งช่องของ historian**: historian ในพื้นหลังบีบอัดประวัติดิบเก่าเป็น **ช่องแบบเป็นชั้น** สรุปตามเวลาแทนข้อความเก่า แต่ละช่องมีคะแนนความสำคัญ หน้าต่างสดจึงเล็กโดยไม่เสียเส้นเรื่อง การสรุปไม่ต้องใช้พลังเขียนโค้ดของเอเจนต์หลัก คุณจึงรัน historian บนโมเดลราคาถูกหรือ local ทั้งหมดได้ ขณะที่เอเจนต์หลักยังอยู่ระดับสูงสุด.
- **การแสดงผลแบบ decay**: ช่องต่าง ๆ แสดงด้วยความละเอียดที่เหมาะกับช่วงเวลานั้น ผ่านกฎ deterministic แบบไม่ใช้ LLM ที่ปรับตัวตามหน้าต่างบริบทของโมเดล ประวัติเก่าจางลงอย่างราบรื่นแทนที่จะหายทันที และเพราะ deterministic ประวัติเดียวกันจะแสดงเหมือนเดิมเสมอ.
- **เอเจนต์บอกว่าจะทิ้งอะไร หรือไม่บอก**: เมื่อเปิด agent-driven reduction เอเจนต์เรียก `ctx_reduce` เพื่อทำเครื่องหมาย output ของเครื่องมือที่เก่าหรือข้อความยาวสำหรับการลบ การทิ้งถูก **เข้าคิวและรับรู้ cache** ใช้เฉพาะช่วงที่ปลอดภัยต่อ cache การลดจึงไม่ทำให้ cache สั่น ปิดมันแล้วเอเจนต์จะไม่ยุ่งกับการจัดการบริบทเลย: output เก่าถูกทิ้งอัตโนมัติตามอายุ พร้อมตัวเลือก caveman compression สำหรับข้อความเก่าที่สุด.
- **เลย์เอาต์ที่ cache คงที่**: ทั้งหมดถูกจัดโครงสร้างให้การทำงานพื้นหลังไม่ทำให้ prefix ของ prompt ที่ cache ไว้ใช้ไม่ได้ cache ของคุณอยู่ได้ตลอดเซสชัน.

ผลลัพธ์: หนึ่งเซสชันรันได้หลายเดือน ไม่มีการหยุด compaction และต้นทุนต่ำกับผู้ให้บริการที่คิดราคา cache คุณดูได้ใน TUI ของ OpenCode ซึ่งแถบข้างสดแสดงการแบ่งบริบทตามแหล่ง สถานะ historian และจำนวนความจำ อัปเดตหลังทุกข้อความ.

> *ทางเลือก (ปิดโดยค่าเริ่มต้น):* **caveman text compression** ค่อย ๆ บีบอัดข้อความ user และ assistant ที่เก่าที่สุดด้วยกฎ deterministic ตามอายุ สำหรับเซสชันที่ปิด agent-driven reduction.

---

## 🧠 การจับข้อมูล

*ความจำฟรี.* เพื่อบีบอัดประวัติของคุณ historian ต้องอ่านทั้งหมด ดังนั้นในรอบเดียวกันมันจะดึงความรู้ที่ควรเก็บตลอดไป เช่น การตัดสินใจ ข้อจำกัด ข้อตกลง ค่า config และยกระดับเป็น **ความจำของโปรเจกต์** จัดหมวดหมู่และพาไปทุกเซสชันในอนาคต ความจำของคุณสร้างตัวเองจากงานที่คุณทำอยู่แล้ว.

เอเจนต์ยังสามารถบันทึกความจำอย่างชัดเจนได้ แม้ส่วนใหญ่จะถูกจับอัตโนมัติให้มัน:

- **`ctx_memory`**: เขียนหรือลบความรู้ข้ามเซสชันโดยตรง ใน taxonomy หมวดหมู่ขนาดเล็ก (`PROJECT_RULES`, `ARCHITECTURE`, `CONSTRAINTS`, `CONFIG_VALUES`, `NAMING`).

```
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

> **การรับรู้เวลา** *(เปิดโดยค่าเริ่มต้น)* ให้เอเจนต์มีความรู้สึกเรื่องเวลา ด้วยตัวบอกช่องว่างอย่าง `+2h 15m` ระหว่างข้อความและช่องที่ลงวันที่ จึงให้เหตุผลได้ว่าเหตุการณ์เกิดขึ้นนานแค่ไหนแล้ว ตั้ง `temporal_awareness: false` เพื่อปิด.

---

## 🌙 การรวบรวมความจำ

*สิ่งที่การนอนทำให้ความจำ.* เอเจนต์ **dreamer** แบบทางเลือกจะรันข้ามคืนเพื่อรักษาคุณภาพความจำ โดยสร้าง child sessions ชั่วคราวสำหรับแต่ละงาน:

- **ตรวจสอบ**: ตรวจความจำทีละส่วนกับ codebase ปัจจุบัน (paths, configs, patterns) และแก้หรือลบข้อเท็จจริงที่เก่า.
- **ดูแล**: สแกน memory pool ทั้งหมดเพื่อรวมรายการซ้ำ ปรับถ้อยคำให้กระชับ และเก็บถาวรรายการที่คุณค่าน้อยหรือซ้ำซ้อน.
- **จัดประเภท**: ให้คะแนนความสำคัญ ขอบเขต และความปลอดภัยในการแชร์ของแต่ละความจำ โดยไม่รบกวน prompt cache สด.
- **ดูแล docs**: ทำให้ `ARCHITECTURE.md` และ `STRUCTURE.md` อัปเดตจากการเปลี่ยนแปลงใน codebase.
- **ความจำของผู้ใช้**: ยกระดับข้อสังเกตที่เกิดซ้ำเกี่ยวกับวิธีทำงานของคุณ (สไตล์สื่อสาร จุดเน้น review รูปแบบการทำงาน) ไปเป็น `<user-profile>` ที่เดินทางไปกับทุกเซสชัน.
- **Smart notes**: ประเมินโน้ตที่เลื่อนเวลาไว้ซึ่ง `surface_condition` เป็นจริงแล้ว และแสดงรายการที่พร้อม.

เพราะมันรันตอนว่าง dreamer จึงเข้ากันดีกับโมเดล local แม้จะช้า ไม่มีใครต้องรอ เรียก run ได้ทุกเมื่อด้วย `/ctx-dream`.

---

## 🔎 การเรียกคืน

*ความจำที่ถูกต้องในเวลาที่ถูกต้อง.* ทุกเทิร์น ความจำโปรเจกต์ที่ active และประวัติเซสชันที่ compact แล้วจะถูกฉีดเข้าอัตโนมัติและเสถียรต่อ cache เมื่อต้องการ เอเจนต์ใช้:

- **`ctx_search`**: query เดียวข้ามสามชั้นพร้อมกัน: **memories** ของโปรเจกต์ ประวัติ **conversation** ดิบ และ **git commits** ที่ทำดัชนี Semantic embeddings พร้อม full-text fallback.

  ```
  ctx_search(query="why did we pick event sourcing for orders")
  ```

- **`ctx_expand`**: ดึงช่วงประวัติที่ถูกบีบอัดกลับเป็น transcript เดิม `U:`/`A:` เมื่อเอเจนต์ต้องการรายละเอียดแน่นอน.
- **`ctx_note`**: scratchpad สำหรับเจตนาที่เลื่อนเวลาไว้ โน้ตจะกลับมาที่ขอบเขตตามธรรมชาติ (หลัง commits, หลัง historian runs, เมื่อ todos เสร็จ) **Smart notes** มีเงื่อนไขเปิดที่ dreamer เฝ้าดู.

การเรียกคืนทำงาน **ข้ามเซสชัน** (เซสชันใหม่รับทุกอย่างต่อ) และ **ข้าม harnesses** (เขียนความจำใน OpenCode แล้วดึงใน Pi).

> **คำใบ้ค้นหาอัตโนมัติ** *(เปิดโดยค่าเริ่มต้น)* รัน `ctx_search` ในพื้นหลังทุกเทิร์นและกระซิบ "ความจำคลุมเครือ" เมื่อมีสิ่งที่เกี่ยวข้อง เหมือนเกือบจำโน้ตที่เคยจดได้ มันเพิ่มเฉพาะชิ้นส่วนกระชับ ไม่เคยเพิ่มเนื้อหาเต็ม; ตั้ง `memory.auto_search.enabled: false` เพื่อปิด **Git commit indexing** *(เลือกเปิด)* ทำให้ประวัติโปรเจกต์ค้นหาเชิง semantic ได้เป็นแหล่งที่สี่ของ `ctx_search` เปิดด้วย `memory.git_commit_indexing.enabled: true`.

### เครื่องมือของเอเจนต์โดยสรุป

| เครื่องมือ | ส่วน | สิ่งที่ทำ |
|------|-------|-------------|
| `ctx_reduce` | บริบท | เข้าคิว tagged content ที่เก่าเพื่อเอาออก โดยรับรู้ cache |
| `ctx_memory` | การจับข้อมูล | เขียนหรือลบความจำถาวรข้ามเซสชัน |
| `ctx_search` | การเรียกคืน | ค้นหาความจำ ประวัติการสนทนา และ git commits |
| `ctx_expand` | การเรียกคืน | คลายช่วงประวัติกลับเป็น transcript |
| `ctx_note` | การเรียกคืน | เจตนาที่เลื่อนเวลาไว้และ smart notes ที่ dreamer ประเมิน |

---

## คำสั่ง

| คำสั่ง | คำอธิบาย |
|---------|-------------|
| `/ctx-status` | มุมมอง debug: tags, pending drops, cache TTL, nudge state, ความคืบหน้า historian, coverage ของช่อง, งบประมาณประวัติ |
| `/ctx-flush` | บังคับ operations ที่เข้าคิวทั้งหมดทันที โดยข้าม cache TTL |
| `/ctx-recomp` | สร้างช่องใหม่จากประวัติดิบ (รับช่วง `start-end`) ใช้เมื่อสถานะที่เก็บดูผิด |
| `/ctx-dream` | รันการดูแล dreamer ตามต้องการ: ดูแลความจำ docs smart notes และ user-profile review |

---

## แอปเดสก์ท็อป

แอปเดสก์ท็อปคู่กันสำหรับเรียกดูและจัดการสถานะ Magic Context นอกเทอร์มินัล.

<p align="center">
  <a href="https://github.com/cortexkit/magic-context/releases"><strong>⬇️ Download for macOS · Windows · Linux</strong></a>
</p>

- **ตัวดูความจำ**: ค้นหา กรอง และแก้ไขความจำโปรเจกต์ตามหมวดหมู่และโปรเจกต์.
- **ประวัติเซสชัน**: ดูช่องและโน้ตของเซสชันใด ๆ ด้วยการนำทางตามเวลา.
- **วินิจฉัย cache**: ไทม์ไลน์ cache hit/miss แบบ real-time และตรวจจับสาเหตุ bust.
- **การจัดการ Dreamer**: ดูประวัติ dream-run เรียก run ตรวจผลลัพธ์งาน.
- **ตัวแก้ไข config**: แก้ไขทุกการตั้งค่าแบบฟอร์ม รวมถึง model fallback chains.
- **ตัวดู log**: live-tailing logs พร้อมค้นหา.

มันอ่านโดยตรงจากฐานข้อมูล SQLite ของ Magic Context ไม่มีเซิร์ฟเวอร์เพิ่ม ไม่มี API มี auto-updates ในตัว.

---

## การกำหนดค่า

การตั้งค่าอยู่ใน `magic-context.jsonc` ทุกอย่างมีค่าเริ่มต้นที่เหมาะสม config ของโปรเจกต์จะ merge ทับการตั้งค่าระดับผู้ใช้ สำหรับอ้างอิงเต็ม รวมถึงการปรับ cache TTL, execute thresholds ต่อโมเดล, การเลือกโมเดล historian และ dreamer, embedding providers และการตั้งค่าหน่วยความจำ ดู **[CONFIGURATION.md](./CONFIGURATION.md)** หรือ **[อ้างอิงการกำหนดค่าบน docs.cortexkit.io](https://docs.cortexkit.io/magic-context/reference/configuration/)**.

**ตำแหน่ง config** (ตำแหน่ง CortexKit ร่วมหนึ่งแห่ง โปรเจกต์ทับผู้ใช้):
1. `<project-root>/.cortexkit/magic-context.jsonc`
2. `~/.config/cortexkit/magic-context.jsonc`

อัปเกรดจากเวอร์ชันก่อน? config เดิมจะถูกย้ายมาที่นี่อัตโนมัติในการรันครั้งแรก (ทิ้ง breadcrumb `.MOVED_READPLEASE` ไว้ที่ path เดิม).

---

## ที่เก็บข้อมูล

สถานะถาวรทั้งหมดอยู่ในฐานข้อมูล SQLite local ภายใต้ CortexKit store ร่วม (`~/.local/share/cortexkit/magic-context/context.db`, ตำแหน่งเทียบเท่า XDG บน Windows; ฐานข้อมูล legacy ในโฟลเดอร์ OpenCode จะ migrate ตอน boot แรก) หากเปิดฐานข้อมูลไม่ได้ Magic Context จะปิดตัวเองและแจ้งคุณ ความจำผูกกับ **ตัวตนโปรเจกต์ที่เสถียร** ที่ได้จาก repo จึงตามโปรเจกต์ไปข้าม worktrees, clones และ forks แทนที่จะผูกกับ path โฟลเดอร์.

Magic Context ยังเขียนไปยังตำแหน่งอื่นบางแห่ง:

| Path | อะไร | ความคงอยู่ |
|---|---|---|
| `~/.local/share/cortexkit/magic-context/context.db` | ฐานข้อมูล SQLite, tags, ช่อง, ความจำ, สถานะถาวรทั้งหมด (เทียบเท่า XDG บน Windows) | **ต้องคงอยู่.** ถ้าหาย จะเสียความจำ/ประวัติ. |
| `~/.local/share/cortexkit/magic-context/models/` | cache โมเดล embedding local (~90 MB `Xenova/all-MiniLM-L6-v2` ONNX), ดาวน์โหลดตอนใช้ครั้งแรกเมื่อเปิด local embeddings | ควรคงอยู่ ไม่เช่นนั้นจะดาวน์โหลดใหม่ทุกครั้ง ไม่ใช้เมื่อ `memory.enabled: false` หรือกำหนด backend embedding `openai_compatible`/`ollama`. |
| `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi) | log วินิจฉัย | ทิ้งได้. |

**สภาพแวดล้อม sandbox / ชั่วคราว (Docker, CI, คอนเทนเนอร์ใช้แล้วทิ้ง):** mount ไดเรกทอรี `~/.local/share/cortexkit/magic-context/` บน persistent volume เพื่อให้ฐานข้อมูลและ cache โมเดลอยู่รอดระหว่างการรัน หากเฉพาะ cache โมเดลเป็นชั่วคราว โมเดลก็แค่ถูกดาวน์โหลดใหม่; หากฐานข้อมูลเป็นชั่วคราว ความจำและประวัติจะไม่สะสม เพื่อหลีกเลี่ยงการดาวน์โหลดโมเดล ~90 MB ทั้งหมด ตั้ง `memory.enabled: false` หรือชี้ `embedding` ไปที่ backend ระยะไกล `openai_compatible`/`ollama`.

---

## ประวัติดาว

<a href="https://www.star-history.com/?repos=cortexkit%2Fmagic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&theme=dark&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
 </picture>
</a>

---

## การพัฒนา

**ข้อกำหนด:** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install         # Install dependencies
bun run build       # Build the plugin
bun run typecheck   # Type-check without emitting
bun test            # Run tests
bun run lint        # Lint (Biome)
bun run format      # Format (Biome)
```

การรัน Dream ต้องใช้เซิร์ฟเวอร์ OpenCode ที่ทำงานอยู่ (dreamer สร้าง child sessions ชั่วคราว) ใช้ `/ctx-dream` ภายใน OpenCode สำหรับการดูแลตามต้องการ.

---

## การมีส่วนร่วม

ยินดีรับ bug reports และ pull requests สำหรับการเปลี่ยนแปลงใหญ่ ให้เปิด issue ก่อนเพื่อหารือแนวทาง รัน `bun run format` ก่อนส่ง; CI ปฏิเสธโค้ดที่ไม่ได้ format.

---

## ใบอนุญาต

[MIT](LICENSE)
