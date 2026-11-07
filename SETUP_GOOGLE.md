# Google Sheets ko database banana: step by step guide

**Kya hoga:** aapki attendance (location ke saath), leave aur payroll ka poora data aapke apne Google Sheet mein save hoga. App (website) us sheet se baat karti hai. Har check-in / check-out ka **latitude, longitude, accuracy aur Google Maps link** sheet ke `ATTENDANCE_EVENTS` tab mein dikhta hai.

Time lagega: lagbhag 30 minute (workbook banne mein 5 to 8 minute khud lagte hain). Sab kuch browser aur terminal se hota hai.

```
Phone / PC browser --HTTPS--> Web app --> API --> Google Sheet (aapka database)
```

> **Zaroori baat:** phone ka browser location sirf **HTTPS** page ko deta hai (ya `localhost`). Isliye final use ke liye site HTTPS par honi chahiye. Testing ke liye `npm run dev:mobile` khud HTTPS de deta hai (step 11).

## Quick summary: Google Sheet se kaise connect hota hai (10 commands)

1. Google Cloud project banao, **Google Sheets API** enable karo.
2. Service account banao, **JSON key** download karo (project folder ke bahar rakho).
3. <https://sheets.new> se **khaali sheet** banao, usko service account ke email ko **Editor** share karo, URL se **Sheet ID** copy karo.
4. `npm install` aur `npm run setup`
5. `.env` mein daalo: `NUTEX_BACKEND=google`, `GOOGLE_SERVICE_ACCOUNT_KEY_FILE=...`, `GOOGLE_SPREADSHEET_ID=...`
6. **Saare tabs + headers + formulas banao**, do tareeke (koi ek):
   - **Apps Script (terminal ke bina):** `google/apps-script/NutexSetup.gs` ka poora code sheet ke Extensions → Apps Script mein paste karo, NUTEX menu → Build workbook.
   - **ya** `npm run google:create`
7. `npm run google:init` (pehla admin / owner aur branch)
8. `npm run google:verify` (0 failed)
9. `npm run build`, phir `npm run start:api` aur `npm run start:web`
10. Browser mein admin se login, aur "Step 12" ke hisaab se employees, salary aur logins banao.

Neeche har step detail mein hai.

---

## Step 1. Google Cloud project banao

1. <https://console.cloud.google.com/> kholo aur apne Google account se login karo (wahi account jisme aap sheet rakhna chahte ho).
2. Upar project selector -> **New project** -> naam `nutex` -> **Create**.

## Step 2. Google Sheets API on karo

1. Left menu: **APIs & Services -> Library**.
2. `Google Sheets API` search karo -> **Enable**.
3. (Optional, sirf payslip PDF / documents ke liye, step 9 dekho) `Google Drive API` bhi **Enable**.

## Step 3. Service account banao (robot user) aur key download karo

App aapke password se nahi, ek "robot account" se sheet ko padhti aur likhti hai.

1. **IAM & Admin -> Service Accounts -> Create service account**. Naam: `nutex-api`. Roles ki zaroorat nahi -> **Done**.
2. Us account par click karo -> **Keys -> Add key -> Create new key -> JSON -> Create**. Ek `.json` file download hogi.
3. Us file ko **is project folder ke bahar** rakho, jaise `C:\secrets\nutex-sa.json`. **Kabhi git / WhatsApp / email mein mat bhejo.** Ye key sheet ki chaabi hai.
4. Service account ka email copy karo: `nutex-api@<project>.iam.gserviceaccount.com` (Details tab mein milta hai).

> Agar "Service account key creation is disabled" aaye: aapki organisation ne policy lagayi hai. Personal Gmail par ye nahi aata. Workspace mein admin se exception maango.

## Step 4. Apni khaali Google Sheet banao aur robot ko share karo (recommended)

1. <https://sheets.new> kholo. Naam do: `NUTEX Attendance and Payroll DB`. **Sheet khaali rehne do.**
2. Browser ke address se **Sheet ID** copy karo:
   `https://docs.google.com/spreadsheets/d/`**`1AbC...xyz`**`/edit`  (bold wala hissa ID hai).
3. **Share** dabao -> step 3 ka service account email daalo -> role **Editor** -> "Notify people" band karo -> **Share**.

*Kyon aise?* Sheet aapki hai, aap use seedha khol sakte ho, aur data aapke Drive mein rehta hai. (Google ke rule ke mutabiq service account ka apna Drive storage quota nahi hota, isliye data ka malik aap hi rehte ho.)

## Step 5. Project ki settings (`.env`)

Terminal mein project folder mein:

```bash
npm install
npm run setup
```

Ye `.env` file banata hai (secret khud generate hota hai). Ab `.env` kholo aur ye lines badlo:

```
NODE_ENV=production
NUTEX_BACKEND=google
COOKIE_SECURE=true
CORS_ORIGIN=https://aapki-site.example.com
COMPANY_TIMEZONE=Asia/Kolkata

GOOGLE_SERVICE_ACCOUNT_KEY_FILE=C:\secrets\nutex-sa.json
GOOGLE_SPREADSHEET_ID=1AbC...xyz
CAPACITY_SCALE=0.25
```

- `CAPACITY_SCALE=0.25` lagbhag 150 employees ke liye kaafi hai. Badi company ke liye `1`. Ye value baad mein mat badlo (workbook ki size iske hisaab se banti hai).
- Abhi sirf phone par test kar rahe ho (HTTPS wali site nahi hai)? To `NODE_ENV=development`, `COOKIE_SECURE=false`, `CORS_ORIGIN=http://localhost:3000` rakho. Production mein wapas upar wali values.

Check karo:

```bash
npm run verify:env
```

## Step 6. Workbook banao: saare tabs, headers, formulas (2 tareeke, koi ek chuno)

Dono tareeke wahi 44 tabs, wahi headers (blue = input, green = formula), wahi formulas, dropdowns aur protections banate hain. Phir `npm run google:verify` dono ko check kar leta hai.

### Tareeka A: Apps Script se (terminal nahi chahiye, aasan)

1. Apni khaali sheet kholo (jo step 4 mein banayi aur service account ko share ki).
2. Menu: **Extensions → Apps Script**.
3. Jo sample code hai woh poora delete karo.
4. Is project ki file **`google/apps-script/NutexSetup.gs`** kholo, **poora code copy** karke wahan paste karo. **Save** (disk icon).
5. Code ke upar `NUTEX_SETTINGS` mein `SERVICE_ACCOUNT_EMAIL: ''` ke andar apna service account email likho (step 3 wala `nutex-api@...iam.gserviceaccount.com`). Isse formula wale columns lock ho jaate hain aur app phir bhi likh sakti hai. Khaali chhodoge to locks baad mein lagenge.
6. Sheet ka tab **reload** karo. Menu mein **NUTEX** dikhega.
7. **NUTEX → Build workbook (all tabs, headers, formulas)**. Pehli baar Google permission maangega: **Review permissions → apna account → Advanced → Go to (unsafe) → Allow**. (Yeh aapki apni script hai, isliye "unverified" dikhta hai.)
8. Neeche daayen "NUTEX" toast aate rahenge ("Tab 12/44: ..."). Script 6 minute ki Google limit ki wajah se tukdon mein chalti hai aur **khud aage badhti rahti hai**, kul 5 se 10 minute. Beech mein sheet band mat karna. Agar ruk jaye to wahi menu dobara dabao.
9. Ant mein "Workbook built: 44 tabs" aayega. **NUTEX → Check workbook** dabao: "OK" aana chahiye.

Dhyan rakhna:
- Yeh script sirf **khaali** sheet par chalti hai. Agar pehle se NUTEX ke tabs hain to mana kar deti hai (naya blank sheet lo).
- Script ke andar capacity `0.25` set hai (lagbhag 150 employees). `.env` mein bhi `CAPACITY_SCALE=0.25` rakho. Alag size chahiye to computer par `npm run apps-script:generate -- --scale=1` chalakar nayi file lo, aur `.env` mein wahi value rakho.
- Script mein koi password ya key nahi hoti.
- Yeh script data (config, roles, employees) nahi daalti. Woh Step 7 (`npm run google:init`) daalta hai.

### Tareeka B: terminal se

```bash
npm run google:create
```

Ye aapki khaali sheet (`GOOGLE_SPREADSHEET_ID`) mein sab bana deta hai. **5 se 8 minute lagte hain** (Google ki speed limit ki wajah se), beech mein band mat karo. Ant mein "Workbook ready" dikhega.

## Step 7. Pehla admin aur pehli branch banao

```bash
npm run google:init
```

Ye kuch sawaal puchta hai: company ka naam, aapka naam, **username**, branch ka naam, latitude / longitude (optional), aur kya sirf branch ke paas check-in allow ho (geofence).

- **Password** aap `.env` mein `ADMIN_PASSWORD=...` de sakte ho, warna script ek password banakar **sirf ek baar** screen par dikhata hai. Likh lo.
- Pehli baar login par app aapse naya password chuna layegi.
- Ye demo data **nahi** daalta, sirf real setup: roles, leave types, salary components, ek General shift, aapki branch aur aap.
- Sirf khaali workbook par chalta hai; dobara chalane par mana kar deta hai.

> `npm run google:seed` alag cheez hai: wo **demo** naam aur demo login daalta hai, sirf trial ke liye. Real company mein use mat karo.

## Step 8. Verify

```bash
npm run google:verify
```

Ant mein `0 failed` aana chahiye. Warning mein Drive folders ki baat ho sakti hai (step 9), wo theek hai.

## Step 9. (Optional) Payslip PDF aur employee documents ke liye Drive

Attendance, location, leave, payroll ki calculation **sirf Sheet se chalti hai**, Drive ki zaroorat nahi. Drive sirf **payslip PDF** aur **employee documents (ID proof etc.)** ke liye hai.

Google ki limit: service account ka apna Drive quota nahi hota, isliye woh personal "My Drive" mein file upload nahi kar sakta. Iske liye **Google Workspace ka Shared Drive** chahiye:

1. Workspace mein ek Shared Drive banao, service account ko usme **Content manager** banao, us mein folder `NUTEX` banao.
2. Us folder ka ID `.env` mein `DRIVE_PARENT_FOLDER_ID=` mein daalo, aur Drive API enable rakho.
3. `npm run google:create` ke bajay folders ke liye Drive mein `employee-documents` aur `payslips` folder khud banao aur unki IDs `.env` mein `DRIVE_DOCS_FOLDER_ID` / `DRIVE_PAYSLIP_FOLDER_ID` mein daalo.

Personal Gmail par ye features band rahenge (baaki sab chalega).

## Step 10. App chalao

Do terminal kholo:

```bash
npm run build                # ek baar
npm run start:api            # terminal 1  (Google se judta hai)
npm run start:web            # terminal 2  (website, http://localhost:3000)
```

Browser mein kholo, step 7 wale username / password se login karo.

Kuch bhi ho to API ka terminal dekho: agar "GOOGLE_SPREADSHEET_ID is not set" jaisa error aaye to `.env` ka path / naam check karo.

## Step 11. Phone par test (location ke saath)

**Sirf test ke liye (PC aur phone ek hi Wi-Fi par):**

```bash
npm run dev:mobile
```

Ye demo data ke saath (Google ke bina) chalta hai aur `https://<PC-ka-IP>:3443` deta hai. Phone par ek baar certificate warning aayegi: **Advanced -> Proceed**. Login: `admin` / `123`. Ye shortcut **sirf is local test mode** mein hai, real (Google) mode mein kabhi nahi.

**Asli use ke liye HTTPS wali site chahiye.** Aasan tareeke:

- Ek chhota server (VPS) + Caddy / nginx (free Let's Encrypt certificate), ya
- Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3000`) jo aapke PC / server ko HTTPS domain deta hai.

Detail: [docs/deployment.md](docs/deployment.md). Domain milne ke baad `.env` mein `CORS_ORIGIN=https://aapka-domain` daalo aur API dobara start karo.

## Step 12. Pehle din app mein kya karna hai (Owner / Admin)

Login ke baad **Dashboard** par "Setup checklist" dikhti hai: kaun si branch ke coordinates baaki hain, kis employee ka login ya salary baaki hai. Wahi order follow karo:

1. **Branch:** Settings -> Organisation -> Branches -> Edit. Branch par khade hokar **"Use my current location"** dabao (latitude / longitude bhar jaate hain). Sirf branch ke paas check-in chahiye to `Geofence required = Y` aur radius (metres) do, jaise 200.
2. **Employee add:** Employees -> **Add employee** (naam, joining date, branch, shift, weekly off).
3. **Salary set:** Employees -> us employee ka **Profile -> Salary tab -> Set salary**. Effective date, Basic, HRA, DA, Conveyance, Special wagairah (monthly rupees) bharo; neeche monthly gross live dikhta hai. Salary badalni ho to **Revise salary**: naya dated row banta hai, purani history kabhi edit nahi hoti (isse purana payroll hamesha wahi rehta hai). Salary ke bina payroll mein "no salary structure" dikhta hai.
4. **Login do:** Employees list mein us employee ke saamne **"Login / password"** dabao (naya employee add karte hi app khud poochti hai), ya Settings -> **Logins -> Create login**. Yeh option **Owner/Admin aur HR admin** ko dikhta hai. Username likho, password chuno ya "Generate" karo. Screen par username + password dikhega (sirf ek baar): woh employee ko do. Default mein employee pehle login par apna password badalta hai.
5. **Employee ka kaam:** woh phone par site kholta hai, login karta hai, **Check in** dabata hai, location **Allow** karta hai; shaam ko **Check out**. Sheet ke `ATTENDANCE_EVENTS` mein dono ke latitude, longitude, accuracy, distance aur `map_url` dikhte hain.
6. **Payroll (har mahine):** Payroll -> naya period banao -> Open -> attendance, leave, OT sheet ke formulas se khud calculate hote hain -> Review -> Approve (jo submit kare, usse alag banda approve karta hai) -> **Lock**. Lock ke baad us mahine ke numbers kabhi nahi badalte. Employee ko apni payslip **Payslips** mein dikhti hai.
7. **Kisi ko hataana:** Employees -> **Remove**. Login band ho jata hai, data delete nahi hota (payroll / audit ke liye), baad mein **Restore** ho sakta hai. Poori tarah nikalna ho to date of exit set karo, taaki aakhri payroll sahi bane.

### Kaun kya dekhta hai

| Role | Dashboard par | Kya kar sakta hai |
|---|---|---|
| **Owner / Admin** (`SUPER_ADMIN`) | Quick actions, setup checklist, aaj ke sabke check-ins (location ke saath), poori company ke numbers | Sab kuch: employees, salary, logins / passwords, branches, settings, manual punch, payroll, reports, audit |
| **HR** | Apni branch ke numbers, approvals | Employees, attendance, leave, shifts, regularisation, aur **apni branch ke employees ko username + password dena / reset karna** (sirf employee, manager, clerk role; admin, HR ya finance login nahi). Salary nahi dekhta |
| **Manager** | Apni team ka aaj, apna check-in | Team ke leave / regularisation approve, apni attendance |
| **Finance** | Payroll aur salary ke numbers | Salary, payroll, compliance, reports |
| **Site clerk** | Branch ki attendance | Branch ki attendance dekhna, regularisation |
| **Employee** | Apna check-in / check-out, is mahine ka hisaab (present, late, hours), leave balance, apni salary aur latest payslip, apne recent check-ins | Khud check in / out, leave apply, regularisation request, apni payslip dekhna |

Employee sirf **apna** data dekhta hai; doosre ki salary, location ya payslip server hi nahi dikhata.

Admin (`SUPER_ADMIN`) ke paas sab permissions hain: employee add / edit / remove, har user ka username + password dena, password reset, login band / chalu, roles badalna, settings, manual punch (jab kisi ka phone kho gaya ho), reports, payroll.

## Sheet mein data kaise dikhta hai

| Tab | Kya hai |
|---|---|
| `ATTENDANCE_EVENTS` | har check-in / check-out: `geo_lat`, `geo_lng`, `geo_accuracy`, `geo_distance_m`, `geo_status`, `map_url` (click karke Google Maps) |
| `ATTENDANCE_DAILY` | din ka hisaab (formula se): present / absent / half day / late |
| `LOCATIONS` | branch, latitude, longitude, radius |
| `EMPLOYEE_SALARY` | har employee ki salary structure (dated rows), `monthly_gross` formula |
| `PAYROLL_CALC` | payroll ka hisaab (formula se): paid days, earnings, deductions, net pay |
| `USERS` | logins (password sirf hash hota hai, asli password kahin nahi) |
| `AUDIT_LOG` | kisne kya kab kiya |

**Sheet ko haath se edit mat karo** (khaaskar formula columns). Kaam app se karo. Sheet sirf kam logon ke saath share karo: protected ranges edit rokte hain, par dekhne wale sab data dekh sakte hain.

## Location ke rules (Settings -> System)

| Key | Matlab | Default |
|---|---|---|
| `PUNCH_REQUIRES_LOCATION` | Y = bina location ke check-in nahi | Y |
| `LOCATION_MAX_ACCURACY_M` | isse kharab (zyada metres) GPS reading reject | 150 |
| `LOCATION_MAX_AGE_SEC` | purani reading reject | 300 |

Honest limitation: browser ki location phone par "fake GPS" app se badli ja sakti hai. Geofence, accuracy check, fresh-reading check, audit log aur manager approvals isse kam karte hain, par ye biometric jaisa pakka saboot nahi hai.

## Backup

```bash
npm run backup
```

Sheet ki copy + har tab ka export banata hai. Hafte mein ek baar chalao. Google Sheets ka **File -> Version history** bhi kaam aata hai.

## Dikkatein (troubleshooting)

| Error / dikkat | Wajah aur hal |
|---|---|
| `The caller does not have permission` / 403 | Sheet service account ko **Editor** share nahi hui (step 4) |
| `Requested entity was not found` / 404 | `GOOGLE_SPREADSHEET_ID` galat hai |
| `Google Sheets API has not been used in project` | Step 2 mein API Enable karo, 2 minute ruko |
| App slow hai | Har Google call ~0.4 second leti hai; app ek request mein kam se kam calls karti hai aur 30 second cache rakhti hai. Phir bhi pehla load slow hota hai. `.env` mein `READ_CACHE_TTL_MS=60000` kar sakte ho |
| HR ko "Logins" nahi dikh raha | Purani sheet ke `ROLES` mein HR ki `users` permission nahi hai. `npm run google:roles` chalao (sirf kami wali rows jodta hai) |
| `Quota exceeded` / 429 | Google limit: 60 reads / min. `READ_CACHE_TTL_MS` badhao (jaise 60000). App khud retry karti hai |
| Apps Script: "Exceeded maximum execution time" | Normal, Google 6 minute mein rokta hai. Script khud agle tukde ke liye trigger lagati hai; na chale to NUTEX → Build workbook dobara dabao (jahan ruki thi wahin se aage badhegi) |
| Apps Script: "already has NUTEX tabs" | Sheet khaali nahi hai. Nayi blank sheet banao (ya adhoori build ho to NUTEX → Reset build progress, purane NUTEX tabs delete karke dobara) |
| Apps Script: protections nahi lage | `SERVICE_ACCOUNT_EMAIL` khaali tha. Email daalkar NUTEX → Add protections only chalao |
| `google:create` beech mein ruk gaya | Nayi khaali sheet banao, naya ID `.env` mein daalo, dobara chalao |
| Login nahi ho raha | Username / password check karo. 5 galat try ke baad account 15 minute lock hota hai. Admin **Settings -> Logins -> Password** se naya de sakta hai |
| Check-in par "Location blocked" | Browser ki address bar mein lock icon -> Location -> Allow, aur phone ki Settings -> Location ON |
| "needs a secure (https) connection" | Site HTTP par hai. HTTPS use karo (step 11) |
| "not accurate enough" | GPS / precise location ON karo, khidki ke paas ya bahar jao. Ya `LOCATION_MAX_ACCURACY_M` badhao |
| "outside the allowed location" | Branch ke radius se bahar ho, ya branch ke coordinates galat hain (Settings -> Branches) |

## Official references

- Sheets API limits: <https://developers.google.com/workspace/sheets/api/limits>
- Service accounts and Drive storage (Shared Drives): <https://developers.google.com/workspace/drive/api/guides/about-shareddrives>
- Browser Geolocation needs a secure context: <https://developer.mozilla.org/docs/Web/API/Geolocation_API>
