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
  <a href="./README.th.md">ไทย</a> |
  <strong>Türkçe</strong> |
  <a href="./README.uk.md">Українська</a> |
  <a href="./README.bn.md">বাংলা</a> |
  <a href="./README.gr.md">Ελληνικά</a> |
  <a href="./README.vi.md">Tiếng Việt</a>
</p>

*Bu bir topluluk çevirisidir. İngilizce [README.md](./README.md) doğruluk kaynağıdır ve daha güncel olabilir.*

<h1 align="center">Magic Context</h1>

<p align="center">
  <strong>Sınırsız bağlam. Kendini yöneten bellek. Ömür boyu süren tek oturum.</strong><br>
  CortexKit'in parçası, kodlama ajanları için hipokampus.
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
  <em>Bir geliştiriciyi tek görev için işe alıp teslim edince kovmazsın.<br>Bunu ajanına yapmayı bırak.</em>
</p>

<p align="center">
  <a href="#magic-context-nedir">Magic Context nedir?</a> ·
  <a href="#hızlı-başlangıç">Hızlı başlangıç</a> ·
  <a href="#cortexkit-parçası">CortexKit</a> ·
  <a href="#bağlam-yönetimi">Bağlam</a> ·
  <a href="#yakalama">Yakalama</a> ·
  <a href="#pekiştirme">Pekiştirme</a> ·
  <a href="#hatırlama">Hatırlama</a> ·
  <a href="https://docs.cortexkit.io/magic-context">Docs</a> ·
  <a href="./CONFIGURATION.md">Configuration</a> ·
  <a href="https://github.com/cortexkit/magic-context/releases?q=dashboard&expanded=true">Dashboard</a> ·
  <a href="https://discord.gg/DSa65w8wuf">💬 Discord</a>
</p>

---

## Magic Context nedir?

Bir geliştiriciyi tek bir bug düzeltmesi için işe alıp değişiklik yayınlandığı anda kovmazsın. İyi olanları tutarsın. Kod tabanını öğrenirler, kararların neden alındığını hatırlarlar ve her hafta daha keskin hale gelirler.

Kodlama ajanları tam tersine çalışır. Her görev, projen hakkında belleği olmayan yeni bir işe alımdır ve her oturumun sonunda onu kovup sıfırdan başlarsın. Görevin ortasında akışı bozan ve bildiklerini sessizce düşüren "compaction" duraklamalarına bile takılırlar. Bu, hipokampus zarar gördüğünde olanla aynı anterograd amnezidir.

Magic Context onlara bir hipokampus verir. Kodlama ajanları için **hipokampus**tur, beynin anılar oluşturan, onları pekiştiren ve geri çağıran kısmıdır, tamamen arka planda çalışır. Bir oturum artık tek kullanımlık yüklenici olmaktan çıkar ve tüm proje boyunca orada olan uzun vadeli takım arkadaşına dönüşür:

- **Yakalama.** historian geçmişini sıkıştırırken kalıcı bilgiyi (kararlar, kısıtlar, kurallar) proje belleğine taşır. Zaten yaptığın işten ücretsiz bir bellek sistemi elde edersin.
- **Pekiştirme.** Gece boyunca dreamer ajanları uykunun senin için yaptığını yapar: anıları kod tabanına göre doğrular, yinelenen ve eski girdileri düzenler, tekrar edenleri yükseltir.
- **Hatırlama.** Doğru anılar her turda otomatik olarak görünür, ajan da gerektiğinde anılar, geçmiş konuşmalar ve git geçmişi içinde arama yapabilir. Oturumlar arasında, OpenCode ve Pi arasında.

İki söz: ajanının **bağlamını yönetmek için asla durmaz** (compaction duraklaması yok, kırık akış yok) ve **asla unutmaz**.

Her proje için bir oturum çalıştır ve haftalar, aylar veya yıllar boyunca sürdür. Birlikte inşa ettiğiniz her şeyi hatırlar.

---

## Hızlı başlangıç

Etkileşimli kurulum sihirbazını çalıştır. Modellerini algılar, her şeyi yapılandırır ve uyumluluğu ele alır.

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/cortexkit/magic-context/master/scripts/install.ps1 | iex
```

**Ya da doğrudan çalıştır (her OS):**
```bash
npx @cortexkit/magic-context@latest setup
```

Sihirbaz hangi harnesses bulunduğunu (OpenCode, Pi veya ikisi) otomatik algılar, plugin ekler, yerleşik compaction özelliğini kapatır, historian ve dreamer için model seçmene yardım eder ve diğer bağlam yönetimi plugins ile çakışmaları çözer. Belirli bir harness hedeflemek için `--harness opencode` veya `--harness pi` kullan.

> **Yerleşik compaction neden kapatılır?** Magic Context bağlamı kendisi yönetir. Host compaction, cache-aware ertelenmiş işlemlerine karışır ve iki kez sıkıştırır.

**Elle kurulum** (OpenCode): `opencode.json` içinde plugin ekle ve compaction kapat, sonra `<project>/.cortexkit/` içine bir `magic-context.jsonc` bırak (kullanıcı geneli varsayılanlar için `~/.config/cortexkit/`). [Yapılandırma başvurusuna](./CONFIGURATION.md) bak.

```jsonc
{
  "plugin": ["@cortexkit/opencode-magic-context"],
  "compaction": { "auto": false, "prune": false }
}
```

**Pi:** `npx @cortexkit/magic-context@latest setup --harness pi` (Pi `>= 0.74.0` gerektirir). Pi uzantısı OpenCode ile aynı veritabanını paylaşır; proje anıları ve embeddings ikisi arasında toplanır.

**Sorun giderme:** `npx @cortexkit/magic-context@latest doctor` harnesses algılar, çakışmaları (compaction, OMO hooks, DCP) kontrol eder, plugin ve TUI kenar çubuğunu doğrular, veritabanında bütünlük kontrolü çalıştırır ve yapabildiklerini düzeltir. Gönderime hazır bug raporu oluşturmak için `--issue` ekle.

Yeni veya uzun süredir devam eden projede aynı şekilde çalışır: kur, harness'i yeniden başlat ve Magic Context o noktadan itibaren bağlamı yakalar. Kurulumdan önceki OpenCode veya Pi oturumlarını geriye dönük doldurmaz.

<details>
<summary><strong>Diğer bağlam yönetimi plugins ile uyumluluk</strong></summary>

<br>

Magic Context bağlam yönetimini uçtan uca sahiplenir, bu yüzden başka bir plugin zaten bu işi yapıyorsa **kendini devre dışı bırakır**. İki bağlam yöneticisini aynı anda çalıştırmak geçmişini iki kez sıkıştırır ve prompt cache'i sarsar. Başlangıçta şunları kontrol eder; setup ve `doctor` her birini çözmene yardım eder, çözülene kadar Magic Context kapalı kalır (fail-safe) ve nedenini söyler:

- **OpenCode built-in compaction** (`compaction.auto` / `compaction.prune`): Magic Context onun yerini alır. Setup kapatır.
- **DCP** (`opencode-dcp`): ayrı bir bağlam budama pluginidir. İkisi birlikte çalışamaz; `plugin` listenden kaldır.
- **oh-my-opencode (OMO)**: setup örtüşen üç hooks'u devre dışı bırakmayı önerir:
  - `preemptive-compaction`: historian ile çakışan compaction tetikler.
  - `context-window-monitor`: Magic Context nudges ile örtüşen kullanım uyarıları ekler.
  - `anthropic-context-window-limit-recovery`: historian'ı atlayan acil compaction tetikler.

Yeniden kontrol ve otomatik düzeltme için istediğin zaman `npx @cortexkit/magic-context@latest doctor` çalıştır.

</details>

---

## CortexKit parçası

Beyin tek bir organ değildir. Yetenekli bir kodlama ajanı da değildir.

**CortexKit** bir plugin ailesidir; her biri beynin farklı bir bölgesine göre modellenmiştir. Birini kur, ajan daha keskin olur. Üçünü de kur, bir beyni olur.

| Plugin | Bölge | Ne yapar |
|---|---|---|
| **Magic Context** *(buradasın)* | Hipokampus ve medial temporal lob | Kendini yöneten bağlam ve uzun vadeli bellek. Proje bilgisini oturumlar arasında oluştururken, pekiştirirken ve hatırlarken oturumları compaction duraklaması olmadan sürdürür. |
| **[AFT](https://github.com/cortexkit/aft)** | Duyumotor korteks | Kod yapısını algılar ve ona hassas davranır. Ajanın için gerçek bir IDE ve OS. |
| **Alfonso** *(yakında)* | Prefrontal korteks | Yürütücü kontrol. Planlar, işi parçalar, ajanları ve modelleri seçer, ne zaman soracağını, doğrulayacağını ve commit edeceğini belirler. |

Magic Context **ihtiyacın olacak 3 plugin'den 1'idir.** O hatırlar; AFT algılar ve davranır; Alfonso karar verir. Tek bir CortexKit store paylaşırlar, böylece bellek harnesses ve araçlar arasında toplanır.

---

## ⚡ Bağlam yönetimi

*Kendini yöneten sınırsız bir oturum.* Çalışırken bağlam penceresi dolar ve alışılmış çözüm olan compaction, ajanı durdurup her şeyi yeniden okutur. Magic Context bunu arka planda sürekli işler, bu yüzden oturum devam eder.

- **Historian bölmelendirmesi**: arka plan historian eski ham geçmişi **katmanlı bölmelere** sıkıştırır, eski mesajların yerine geçen kronolojik özetler oluşturur. Her birinin önem puanı vardır, canlı pencere ipi kaybetmeden küçük kalır. Özetleme ana ajanının kodlama gücünü gerektirmez, bu yüzden historian'ı ucuz veya tamamen local bir modelde çalıştırırken ana ajanı üst seviyede tutabilirsin.
- **Decay rendering**: bölmeler o an için doğru ayrıntı düzeyinde, modelin bağlam penceresine kendini ayarlayan deterministik ve no-LLM bir kuralla render edilir. Eski geçmiş uçurumdan düşmek yerine zarifçe solar ve deterministik olduğu için aynı geçmiş her zaman aynı şekilde render edilir.
- **Ajan neyin atılacağını söyler, ya da söylemez**: agent-driven reduction açıkken ajan `ctx_reduce` çağırarak eski tool outputs veya uzun mesajları kaldırma için işaretler. Drops **kuyruğa alınır ve cache-aware** olur, yalnızca cache-safe anlarda uygulanır, bu yüzden azaltma cache'i bozmaz. Kapatırsan ajan bağlam yönetiminden tamamen çıkar: eski output yaşa göre otomatik atılır, en eski metin için isteğe bağlı caveman sıkıştırması vardır.
- **Cache-stabil düzen**: tüm bunlar arka plan çalışmasının prompt'un cache'lenmiş prefix'ini asla geçersiz kılmayacağı şekilde yapılandırılır. Cache'in tüm oturum boyunca hayatta kalır.

Sonuç: tek bir oturum aylarca çalışır, compaction duraklaması olmaz ve cache fiyatlı sağlayıcılarda düşük maliyetlidir. Bunu OpenCode TUI içinde görebilirsin; canlı kenar çubuğu kaynağa göre bağlam dökümünü, historian durumunu ve bellek sayılarını gösterir, her mesajdan sonra güncellenir.

> *İsteğe bağlı (varsayılan kapalı):* **caveman text compression** agent-driven reduction kapalı çalışan oturumlarda, en eski user ve assistant metnini deterministik yaş katmanı kuralıyla kademeli sıkıştırır.

---

## 🧠 Yakalama

*Bedava bellek.* Geçmişini sıkıştırmak için historian tamamını okumak zorundadır. Aynı geçişte sonsuza dek saklanmaya değer bilgiyi, kararları, kısıtları, kuralları ve yapılandırma değerlerini çıkarır, bunları **proje belleğine** yükseltir, kategorize eder ve gelecekteki her oturuma taşır. Belleğin zaten yaptığın işten kendi kendini kurar.

Ajan ayrıca anıları açıkça kaydedebilir, ancak çoğu onun için otomatik yakalanır:

- **`ctx_memory`**: küçük bir kategori taksonomisinde (`PROJECT_RULES`, `ARCHITECTURE`, `CONSTRAINTS`, `CONFIG_VALUES`, `NAMING`) oturumlar arası bilgiyi doğrudan yaz veya sil.

```
ctx_memory(action="write", category="ARCHITECTURE", content="Event sourcing for orders.")
```

> **Zaman farkındalığı** *(varsayılan açık)* mesajlar arasındaki `+2h 15m` gibi boşluk işaretleri ve tarihli bölmelerle ajana zaman hissi verir, böylece bir şeyin ne kadar önce olduğunu akıl yürütebilir. Kapatmak için `temporal_awareness: false` ayarla.

---

## 🌙 Pekiştirme

*Uykunun bellek için yaptığı şey.* İsteğe bağlı **dreamer** ajanı bellek kalitesini yüksek tutmak için gece çalışır ve her görev için geçici child sessions başlatır:

- **Doğrula**: anıları mevcut codebase'e (paths, configs, patterns) göre artımlı kontrol et ve eski gerçekleri düzelt veya kaldır.
- **Düzenle**: tüm bellek havuzunu tara, yinelenenleri birleştir, ifadeleri sıkılaştır, düşük değerli veya gereksiz girdileri arşivle.
- **Sınıflandır**: canlı prompt cache'i bozmadan her anının önemini, kapsamını ve güvenli paylaşılabilirliğini puanla.
- **Docs bakımı**: codebase değişikliklerinden `ARCHITECTURE.md` ve `STRUCTURE.md` güncel tut.
- **Kullanıcı anıları**: nasıl çalıştığına dair tekrar eden gözlemleri (iletişim tarzı, review odağı, çalışma kalıpları) her oturumla taşınan bir `<user-profile>` içine yükselt.
- **Smart notes**: `surface_condition` gerçekleşmiş ertelenmiş notları değerlendir ve hazır olanları göster.

Boş zamanda çalıştığı için dreamer yerel modellerle, yavaş olanlarla bile iyi eşleşir. Kimse beklemez. İstediğin zaman `/ctx-dream` ile run tetikle.

---

## 🔎 Hatırlama

*Doğru anda doğru bellek.* Her turda aktif proje anıları ve sıkıştırılmış oturum geçmişi otomatik ve cache-stabil biçimde enjekte edilir. İstek üzerine ajan şunlara başvurur:

- **`ctx_search`**: aynı anda üç katmanda tek sorgu: proje **memories**, ham **conversation** geçmişi ve indekslenmiş **git commits**. Full-text fallback ile semantic embeddings.

  ```
  ctx_search(query="why did we pick event sourcing for orders")
  ```

- **`ctx_expand`**: ajan kesin ayrıntılara ihtiyaç duyduğunda sıkıştırılmış geçmiş aralığını özgün `U:`/`A:` transcript haline geri getir.
- **`ctx_note`**: ertelenmiş niyetler için scratchpad. Notlar doğal sınırlarda yeniden yüzeye çıkar (commits sonrası, historian runs sonrası, todos bitince). **Smart notes** dreamer'ın izlediği açık uçlu koşul taşır.

Hatırlama **oturumlar arasında** (yeni oturum her şeyi devralır) ve **harnesses arasında** (OpenCode içinde anı yaz, Pi içinde al) çalışır.

> **Otomatik arama ipuçları** *(varsayılan açık)* her tur arka planda `ctx_search` çalıştırır ve ilgili bir şey olduğunda, aldığın notu neredeyse hatırlamak gibi, "belirsiz hatırlama" fısıldar. Yalnızca kompakt parçalar ekler, asla tam içerik eklemez; kapatmak için `memory.auto_search.enabled: false` ayarla. **Git commit indexing** *(opt-in)* proje geçmişini dördüncü `ctx_search` kaynağı olarak semantik aranabilir yapar, `memory.git_commit_indexing.enabled: true` ile etkinleştir.

### Ajan araçlarına hızlı bakış

| Araç | Bölüm | Ne yapar |
|------|-------|-------------|
| `ctx_reduce` | Bağlam | Eski tagged content'i cache-aware şekilde kaldırma kuyruğuna alır |
| `ctx_memory` | Yakalama | Kalıcı oturumlar arası anıları yazar veya siler |
| `ctx_search` | Hatırlama | Anıları, konuşma geçmişini ve git commits arar |
| `ctx_expand` | Hatırlama | Bir geçmiş aralığını transcript'e geri açar |
| `ctx_note` | Hatırlama | Ertelenmiş niyetler ve dreamer değerlendirmeli smart notes |

---

## Komutlar

| Komut | Açıklama |
|---------|-------------|
| `/ctx-status` | Debug görünümü: tags, pending drops, cache TTL, nudge state, historian ilerlemesi, bölme kapsamı, geçmiş bütçesi |
| `/ctx-flush` | Kuyruktaki tüm operasyonları cache TTL atlayarak hemen zorla |
| `/ctx-recomp` | Ham geçmişten bölmeleri yeniden oluştur (`start-end` aralığı kabul eder). Saklanan durum yanlış görünürse kullan |
| `/ctx-dream` | İstek üzerine dreamer bakımı çalıştır: bellek, docs, smart notes ve user-profile review bakımı |

---

## Masaüstü uygulaması

Magic Context durumunu terminal dışında gezmek ve yönetmek için eşlik eden masaüstü uygulaması.

<p align="center">
  <a href="https://github.com/cortexkit/magic-context/releases"><strong>⬇️ Download for macOS · Windows · Linux</strong></a>
</p>

- **Bellek tarayıcı**: proje anılarını kategori ve projeye göre ara, filtrele ve düzenle.
- **Oturum geçmişi**: zaman çizelgesi gezintisiyle herhangi bir oturumun bölmelerini ve notlarını incele.
- **Cache tanıları**: gerçek zamanlı cache hit/miss zaman çizelgesi ve bust nedeni tespiti.
- **Dreamer yönetimi**: dream-run geçmişini gör, runs tetikle, görev sonuçlarını incele.
- **Yapılandırma editörü**: model fallback chains dahil her ayar için form tabanlı düzenleme.
- **Log görüntüleyici**: arama ile live-tailing logs.

Doğrudan Magic Context SQLite veritabanından okur. Ek sunucu yok, API yok. Otomatik güncellemeler yerleşiktir.

---

## Yapılandırma

Ayarlar `magic-context.jsonc` içinde yaşar. Her şeyin makul varsayılanları vardır; proje yapılandırması kullanıcı geneli ayarların üstüne birleşir. Tam başvuru, cache TTL ayarı, model başına execute eşikleri, historian ve dreamer model seçimi, embedding providers ve bellek ayarları için **[CONFIGURATION.md](./CONFIGURATION.md)** veya **[docs.cortexkit.io üzerindeki yapılandırma başvurusu](https://docs.cortexkit.io/magic-context/reference/configuration/)** bölümüne bak.

**Yapılandırma konumları** (tek paylaşılan CortexKit konumu, proje kullanıcıyı geçersiz kılar):
1. `<project-root>/.cortexkit/magic-context.jsonc`
2. `~/.config/cortexkit/magic-context.jsonc`

Eski bir sürümden yükseltiyor musun? Mevcut yapılandırman ilk çalıştırmada otomatik olarak buraya taşınır (eski yolda `.MOVED_READPLEASE` izi bırakılır).

---

## Depolama

Tüm kalıcı durum paylaşılan CortexKit store altında yerel bir SQLite veritabanında yaşar (`~/.local/share/cortexkit/magic-context/context.db`, Windows'ta XDG karşılığı; eski OpenCode klasör veritabanları ilk açılışta taşınır). Veritabanı açılamazsa Magic Context kendini kapatır ve seni bilgilendirir. Anılar repo'dan türetilmiş **kararlı proje kimliğine** bağlanır, bu yüzden bir dizin yoluna bağlı kalmak yerine worktrees, clones ve forks boyunca projeyi izler.

Magic Context birkaç başka konuma da yazar:

| Yol | Ne | Kalıcılık |
|---|---|---|
| `~/.local/share/cortexkit/magic-context/context.db` | SQLite veritabanı, tags, bölmeler, anılar, tüm kalıcı durum (Windows'ta XDG karşılığı) | **Kalıcı olmalı.** Kaybedersen bellek/geçmiş kaybolur. |
| `~/.local/share/cortexkit/magic-context/models/` | Yerel embedding model cache (~90 MB `Xenova/all-MiniLM-L6-v2` ONNX), local embeddings açıkken ilk kullanımda indirilir | Kalıcı olmalı, yoksa her çalıştırmada yeniden indirilir. `memory.enabled: false` olduğunda veya `openai_compatible`/`ollama` embedding backend yapılandırıldığında kullanılmaz. |
| `${TMPDIR}/opencode/magic-context/magic-context.log` (`pi/` for Pi) | Tanı logu | Atılabilir. |

**Sandbox / geçici ortamlar (Docker, CI, tek kullanımlık containerlar):** `~/.local/share/cortexkit/magic-context/` dizinini kalıcı volume üzerine bağla ki veritabanı ve model cache çalıştırmalar arasında kalsın. Yalnızca model cache geçiciyse model yeniden indirilir; veritabanı geçiciyse bellek ve geçmiş birikmez. ~90 MB model indirmesinden tamamen kaçınmak için `memory.enabled: false` ayarla veya `embedding` değerini uzak bir `openai_compatible`/`ollama` backend'e yönlendir.

---

## Yıldız geçmişi

<a href="https://www.star-history.com/?repos=cortexkit%2Fmagic-context&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&theme=dark&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=cortexkit/magic-context&type=date&legend=bottom-right&sealed_token=8tgpBwlCfG4Vl1P1ink58E2ocwGiJZ7EfwQLdovNyFh8gqF6In4EhvfaIx8p_C6KztsJtU389KpouCB0HKrjDqN06WULjeHrc1uGhnHHpqDJHv_eAa2zWA" />
 </picture>
</a>

---

## Geliştirme

**Gereksinimler:** [Bun](https://bun.sh) ≥ 1.0

```sh
bun install         # Install dependencies
bun run build       # Build the plugin
bun run typecheck   # Type-check without emitting
bun test            # Run tests
bun run lint        # Lint (Biome)
bun run format      # Format (Biome)
```

Dream yürütmesi canlı bir OpenCode sunucusu gerektirir (dreamer geçici child sessions oluşturur). İstek üzerine bakım için OpenCode içinde `/ctx-dream` kullan.

---

## Katkıda bulunma

Bug reports ve pull requests memnuniyetle karşılanır. Daha büyük değişiklikler için önce yaklaşımı tartışmak üzere issue aç. Göndermeden önce `bun run format` çalıştır; CI biçimlendirilmemiş kodu reddeder.

---

## Lisans

[MIT](LICENSE)
