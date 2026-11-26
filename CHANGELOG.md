# Changelog

All notable changes to RemoteCLI will be documented in this file.


## [1.2.0](https://github.com/tunghuynh/remote-cli/compare/v1.2.0-beta...v1.2.0) (2026-11-26)

### Bug Fixes

* **security:** harden TOTP re-enroll, process-tree kill and hidden agent rules ([0732a59](https://github.com/tunghuynh/remote-cli/commit/0732a594c852e511746b8e85d06d18f618826324))

## [1.2.0-beta](https://github.com/tunghuynh/remote-cli/compare/v1.1.0...v1.2.0-beta) (2026-11-25)

### New Features

* **agent-profiles:** agent orchestration, agent monitor, models settings and message times ([be26ec8](https://github.com/tunghuynh/remote-cli/commit/be26ec809cec5c303da848e89737cac00e24ffba))

### Maintenance

* **video:** remove the promo video generator and its rendered assets ([f54338e](https://github.com/tunghuynh/remote-cli/commit/f54338e26f7e8f435db0646747e37692eee1f679))

## [1.1.0](https://github.com/tunghuynh/remote-cli/compare/v1.0.12...v1.1.0) (2026-11-25)

### New Features

* **auth:** add browser TOTP enrollment and verification (A-02, T-09, C-09) ([397b93e](https://github.com/tunghuynh/remote-cli/commit/397b93ec3c13f885a0967529e490d9ba3a6e6d74))
* **auth:** add TOTP verification and recovery (A-01, T-00, T-01, T-02, T-03, T-04, T-05, T-06, T-07, T-08, T-10, C-09) ([253a632](https://github.com/tunghuynh/remote-cli/commit/253a63222532a09cddf0b2c59603d051cc221c3b))
* **auth:** authenticate the HTML preview frame load with the browser session ([a759576](https://github.com/tunghuynh/remote-cli/commit/a75957678d918c23d583f92240725344c5900a75))
* **auth:** let the app frame load the HTML preview page without the request header ([0aa656d](https://github.com/tunghuynh/remote-cli/commit/0aa656d05005905c2443a6c682f50afe9fdce875))
* **auth:** record replacing recovery codes and disabling TOTP as session events ([49a10cf](https://github.com/tunghuynh/remote-cli/commit/49a10cf76c0f7a9b0baedeebafd0110bfd16175e))
* **code-editor:** run the scripts of a saved HTML file in an isolated preview frame ([9477f43](https://github.com/tunghuynh/remote-cli/commit/9477f43cd260c4fbe343c5d06cc045c1d274ece5))
* **file-tree:** serve saved HTML files as an isolated preview page ([7fd7f85](https://github.com/tunghuynh/remote-cli/commit/7fd7f85b118d1232c238180952adc26494c5b90a))
* **file-tree:** serve the HTML preview page to requests from the Remote bridge ([7d88305](https://github.com/tunghuynh/remote-cli/commit/7d8830562f15e82b8a739663a0e5ef533795606e))
* **plugins:** add a switch that turns plugins off (PD-01, PD-02, PD-03, PD-07) ([c4efd73](https://github.com/tunghuynh/remote-cli/commit/c4efd736454880820c7b079aa5cd6aad78887c0a))
* **plugins:** refuse plugin WebSocket connections while plugins are off (PD-04) ([150e53b](https://github.com/tunghuynh/remote-cli/commit/150e53bf2d9f0736d60f595bf2f4d3163f500868))
* **plugins:** show that plugins are off and load no plugin code (PD-05, PD-06) ([75bd45d](https://github.com/tunghuynh/remote-cli/commit/75bd45ddda33faa1f5d5f417125874e667421c14))
* **remote:** allow plugin blob scripts on the app page only and give static pages their own CSP ([7537678](https://github.com/tunghuynh/remote-cli/commit/7537678f49952d3d63ad875de95eee207d5c956d))
* **remote:** allow the HTML preview page in the Remote route policy ([4db81f7](https://github.com/tunghuynh/remote-cli/commit/4db81f79b04ae591a94e860721adf06835d3d024))
* **remote:** load the HTML preview page into a frame through the Controller proxy ([63ea22a](https://github.com/tunghuynh/remote-cli/commit/63ea22a7ca4a47ce774efbebd6038517a8ab8444))
* **remote:** serve the API docs syntax highlighter from the own origin ([2ede767](https://github.com/tunghuynh/remote-cli/commit/2ede767d0b9cfd39d71ec7cc2a03b5d0cdd4d36b))
* **remote:** tighten the page CSP (CS-02, CS-03, CS-04, CS-06, CS-10) ([3097078](https://github.com/tunghuynh/remote-cli/commit/309707882c2fce634d2fa142e9e4aaf3e1c351bd))
* **settings:** ask for a password and a new code before replacing recovery codes or disabling ([d2beb5b](https://github.com/tunghuynh/remote-cli/commit/d2beb5bc549c43db8ad7d4fdac308214dd55a02b))
* **web:** run the HTML preview of a Remote tab in the isolated frame ([a9ed6b8](https://github.com/tunghuynh/remote-cli/commit/a9ed6b8aadd1735085cc892c370148b655a076df))

### Bug Fixes

* **auth:** initialize browser family when issuing sessions (A-03, K-07) ([76e03ef](https://github.com/tunghuynh/remote-cli/commit/76e03efb3aa4a4210ff10020b8551e96727a3cc1))
* **auth:** require a password and a new code to replace recovery codes or disable TOTP ([291687b](https://github.com/tunghuynh/remote-cli/commit/291687b408fa700f203ab0919a1a506ed798a34c))
* **auth:** show the expiry notice only when a session ended (SF-01) ([d59e410](https://github.com/tunghuynh/remote-cli/commit/d59e41037a581146f7093237fa07bacd984eaabd))
* **auth:** track the signed-in user for the expiry listener in an effect (SF-01) ([db2e718](https://github.com/tunghuynh/remote-cli/commit/db2e7186e803afc13987c7cac5f8bebd96a47ab3))
* **chat:** reconcile live provider error variants (EH-03) ([8e14035](https://github.com/tunghuynh/remote-cli/commit/8e1403594d3a24b116060d1bb8cafdf1eb183d5a))
* **chat:** reconcile recorded and replayed turn errors (EH-03) ([c5766ae](https://github.com/tunghuynh/remote-cli/commit/c5766aede43b1f0803c64f1bad3d270fb5629bbf))
* **code-editor:** sanitize the Mermaid SVG before inserting it (CS-05) ([c0c46f1](https://github.com/tunghuynh/remote-cli/commit/c0c46f1fcfd2635cab7c980df99d26e979b198d1))
* **codex:** restore recorded turn errors (EH-01, EH-07) ([46fa7b7](https://github.com/tunghuynh/remote-cli/commit/46fa7b7527c55a0dd10745dc13c5820daef0dd2f))
* **codex:** unwrap nested recorded error messages (EH-01) ([0014ea5](https://github.com/tunghuynh/remote-cli/commit/0014ea5ea239662ef7d3af273a7c9a1beb0102d2))
* **file-tree:** refuse the HTML preview page to a browser that sends no Fetch Metadata ([0ba654b](https://github.com/tunghuynh/remote-cli/commit/0ba654b0e28ed1bd92342a3b549f21bc0140515e))
* **plugins:** turn plugins off in front of the plugin router (PD-03) ([4650e07](https://github.com/tunghuynh/remote-cli/commit/4650e073d8ee3fbced8440b7c505054cba7cb124))
* preserve TOTP loading text encoding (L-10, K-23) ([18a7c86](https://github.com/tunghuynh/remote-cli/commit/18a7c86a3af547fc8b50480fd0d48b6e51959809))
* **providers:** normalize recorded API errors (EH-02) ([e462ed8](https://github.com/tunghuynh/remote-cli/commit/e462ed86c8db1313e2a34ae24481c2c59dcc40e5))
* **remote:** show the Host list state instead of a blank page (SF-02) ([3270a74](https://github.com/tunghuynh/remote-cli/commit/3270a740db2a9eb2d03910be080f4bdcec3c0afc))
* **security:** accept API keys only in headers and strip app secrets from PTY env ([d35ec85](https://github.com/tunghuynh/remote-cli/commit/d35ec85131ff9dc6028b59e5d16687d16cbd9e01))
* **settings:** keep focus on an API key toggle after it changes (SF-03) ([bf213e2](https://github.com/tunghuynh/remote-cli/commit/bf213e253c4f0b43530b6a50176ccaf21d3f5be4))
* **sidebar:** collapse overflow projects and keep active work visible (PL-01..05) ([5df53ef](https://github.com/tunghuynh/remote-cli/commit/5df53efb5eb1d8bea731a77b1ce911eb2413765f))
* **ws:** reject cross-origin upgrades to /ws and /shell ([7ebdeaa](https://github.com/tunghuynh/remote-cli/commit/7ebdeaa868c1df82f4386d4c749adfd6d700f0e5))

### Refactoring

* **file-tree:** export the HTML preview page policy through the module barrel ([5761b60](https://github.com/tunghuynh/remote-cli/commit/5761b604563088080a3e067f89e7485a910982b4))

### Documentation

* add the HTML preview isolation to Security & Privacy ([737bc88](https://github.com/tunghuynh/remote-cli/commit/737bc88b0cb6d8433c896e26431a2a2d94f3dfed))
* **auth:** add a journal for the password and code check on TOTP changes ([5c2b166](https://github.com/tunghuynh/remote-cli/commit/5c2b166c68d058ce11d54170f6127f83f3b7c04f))
* **auth:** add auth module guide and journal for cookie sessions, TOTP and session lock ([da57a93](https://github.com/tunghuynh/remote-cli/commit/da57a93d92b3ebb1544f975167e6c85bde84a1b7))
* **auth:** describe the cookie authentication of the Remote preview frame load ([6199c79](https://github.com/tunghuynh/remote-cli/commit/6199c79b62b50afd82d9d3cb97628346132a8f76))
* **auth:** document the step-up for disabling TOTP and replacing recovery codes ([1c6cc67](https://github.com/tunghuynh/remote-cli/commit/1c6cc67d9dcb8ac644715d17040b7a48cb78e589))
* document the plugin switch (PD-08) ([87ce682](https://github.com/tunghuynh/remote-cli/commit/87ce6821abb20d7ec1b00036557471bfca26648a))
* explain current API authentication (R7-07) ([cb46cfe](https://github.com/tunghuynh/remote-cli/commit/cb46cfe678e84a7c62416b7f764038d8d9668694))
* install relay dependencies before server tests (BL-03) ([7555e79](https://github.com/tunghuynh/remote-cli/commit/7555e795e7cbec20fe6913e116238d2e020cfd9b))
* **readme:** document two-factor sign-in, session lock and auth settings ([34091f8](https://github.com/tunghuynh/remote-cli/commit/34091f84f0bc9dce186945d26050a6c93402a1cd))
* **remote:** add a guide for the Controller proxy, the route policy and the preview frame load ([c2e97be](https://github.com/tunghuynh/remote-cli/commit/c2e97bede209edb8584b1fa11e8c26463d1fe8c1))
* **remote:** add a journal for the HTML preview with scripts in Remote tabs ([255d406](https://github.com/tunghuynh/remote-cli/commit/255d4061d6dcb3a2c61342d318acd07682fd57ee))

### Styling

* **auth:** normalize session throttle imports (TH-01) ([06473ff](https://github.com/tunghuynh/remote-cli/commit/06473ff8be4d22412bf2ac77d49501f8fd8c7183))
* **workspace:** normalize quick-lock header ordering ([e99164e](https://github.com/tunghuynh/remote-cli/commit/e99164e385676ed5bd2fca094c8b708627af6516))

### Maintenance

* allowlist the fake test values for the secret scanner ([b02d618](https://github.com/tunghuynh/remote-cli/commit/b02d618aa65f0b768f27418fd34645059d797f21))
* pin TOTP and QR dependencies (REG-05) ([db459e7](https://github.com/tunghuynh/remote-cli/commit/db459e78e7067ac666049a43263991b2d207d7d0))
* use the npm registry for locked packages (REG-01) ([b984aac](https://github.com/tunghuynh/remote-cli/commit/b984aac7813c7664a71d41ac6cafd228d4fc953d))

### Tests

* **auth:** inventory real MFA router registrations (A-01, C-09) ([bc334f6](https://github.com/tunghuynh/remote-cli/commit/bc334f616f184056ae55413bd4fa14070f4f8760))
* **chat:** render provider error markup as text (EH-05, EH-07) ([2ce3815](https://github.com/tunghuynh/remote-cli/commit/2ce3815662e0b3542e194261d2f380637e34b615))
* cover TOTP master key recovery at startup (T-02, Q-06) ([b9e773f](https://github.com/tunghuynh/remote-cli/commit/b9e773f7c5758b050c8b79745a2bd2e7e4645559))
* **e2e:** authenticate Local requests with the session cookie (SF-04) ([c057cbe](https://github.com/tunghuynh/remote-cli/commit/c057cbef57c19231577f7e6a8f0647a3e89b6c06))
* **e2e:** expect blob: scripts on the Local page only while plugins are on ([104af22](https://github.com/tunghuynh/remote-cli/commit/104af225c7cdc8bc5b5a399bc2505bcae16f2c08))
* **e2e:** keep server data off /tmp on Linux (SF-05) ([5d56fa6](https://github.com/tunghuynh/remote-cli/commit/5d56fa62f66f3a1cf6e07e77974168a327403f92))
* isolate connection indicator from quick lock (QL-07) ([29ad9ba](https://github.com/tunghuynh/remote-cli/commit/29ad9ba9bdc088a00169fd29836438ad56b4572b))
* isolate remembered Host selection between cases (UI-08) ([d7086b7](https://github.com/tunghuynh/remote-cli/commit/d7086b793ca8ab29ef3fc0a4e061ac1fe6fdf918))
* **plugins:** cover the plugin switch on the server (PD-10) ([59d20cb](https://github.com/tunghuynh/remote-cli/commit/59d20cb5775001cded79b9ddbb65d43107fae205))
* **plugins:** import through module barrels in the plugin switch tests (PD-10) ([12f1582](https://github.com/tunghuynh/remote-cli/commit/12f15822327fe7d6072c0fb80d1546ba3888966d))
* **remote:** check Host-list strings across registered locales via the i18n barrel (SF-02) ([c6bb957](https://github.com/tunghuynh/remote-cli/commit/c6bb957699d2e00fec4daba2ffb52be5c4e5a6bd))
* **remote:** check that a Host revoke refuses the preview frame load ([f74b0bf](https://github.com/tunghuynh/remote-cli/commit/f74b0bf58e9d0b19ba1d14f06a0cd990b66440cc))
* **remote:** check that the preview answer allows no credentialed cross-origin read ([02357ca](https://github.com/tunghuynh/remote-cli/commit/02357ca3ffe629c7ec70720887a237d06668e0fc))
* **remote:** check the HTML preview page through a real Controller and Host ([dea4c91](https://github.com/tunghuynh/remote-cli/commit/dea4c9124ea0426d43bc2186bf1a0d25ddedb992))
* report missing relay vitest setup (BL-02) ([b044e76](https://github.com/tunghuynh/remote-cli/commit/b044e7677b7fa240f622cfc2bc5e61838433bb35))
* skip absent parent workspace docs (BL-01) ([25a4354](https://github.com/tunghuynh/remote-cli/commit/25a43541d569958d3ca20c65bac8b3ed36c338ef))
* **support:** add a shared login-phrase helper for tests ([2855672](https://github.com/tunghuynh/remote-cli/commit/285567256ffab528ec399ccdc88c5aced94083ed))
* use supported project role query (R7-08) ([6caf394](https://github.com/tunghuynh/remote-cli/commit/6caf394dec92f58e4bfd5957e1c65ce6d8507ec2))
* verify logout clears Host navigation storage (UI-12) ([f3310b4](https://github.com/tunghuynh/remote-cli/commit/f3310b496ca073b8d4dddc525ce400de9843c923))

## [1.0.12](https://github.com/tunghuynh/remote-cli/compare/v1.0.11...v1.0.12) (2026-11-19)

### Bug Fixes

* **web:** stop stale builds from pinning missing assets ([d656720](https://github.com/tunghuynh/remote-cli/commit/d6567203f7f8199d14e049e7bc0959c1b3ebcbb9))

## [1.0.11](https://github.com/tunghuynh/remote-cli/compare/v1.0.10...v1.0.11) (2026-11-19)

### Bug Fixes

* **web:** stop stale builds from pinning missing assets ([d656720](https://github.com/tunghuynh/remote-cli/commit/d6567203f7f8199d14e049e7bc0959c1b3ebcbb9))

### Tests

* **web:** accept the service worker registration with update options ([53c69f1](https://github.com/tunghuynh/remote-cli/commit/53c69f105f5e70064e13b367657dcf530fc4b3cf))

## [1.0.10](https://github.com/tunghuynh/remote-cli/compare/v1.0.9...v1.0.10) (2026-11-13)

### Maintenance

* bump package version for npm registry release


## [1.0.9](https://github.com/tunghuynh/remote-cli/compare/v1.0.8...v1.0.9) (2026-11-13)

### New Features

* **chat:** add compact muted timestamp under chat messages ([a3709c8](https://github.com/tunghuynh/remote-cli/commit/a3709c8ea61be8f44640ce28505b05517da5f64e))

### Documentation

* **journal:** add technical journal for chat timestamp feature ([737f9e6](https://github.com/tunghuynh/remote-cli/commit/737f9e6a3e2550ad7367fbcaf4a32a011bf2fd79))

## [1.0.7](https://github.com/tunghuynh/remote-cli/compare/v1.0.6...v1.0.7) (2026-11-13)

### Bug Fixes

* **system:** support Windows shell during update to fix spawn sh ENOENT ([a2a4ad1](https://github.com/tunghuynh/remote-cli/commit/a2a4ad14b35bbcfaf9c58f9b09456d99e88a28fb))

### Maintenance

* make release.sh executable ([4cf1cb1](https://github.com/tunghuynh/remote-cli/commit/4cf1cb177462a6c0b0831c004a67bf70c7d14e2a))

## [1.0.6](https://github.com/tunghuynh/remote-cli/compare/v1.0.5...v1.0.6) (2026-11-13)

### Bug Fixes

* **docs:** use jsdelivr cdn for screenshots to render reliably on npm ([2e8cc14](https://github.com/tunghuynh/remote-cli/commit/2e8cc14f26087beff2162992b8d1f150d2a943c6))

## [1.0.5](https://github.com/tunghuynh/remote-cli/compare/v1.0.4...v1.0.5) (2026-11-13)

### Documentation

* add remote work and cloudflare relay setup guide to README ([096a400](https://github.com/tunghuynh/remote-cli/commit/096a400c89153d4b19896898966d0783dd5b194c))

## [1.0.4](https://github.com/tunghuynh/remote-cli/compare/v1.0.3...v1.0.4) (2026-11-13)

## [1.0.3](https://github.com/tunghuynh/remote-cli/compare/v1.0.2...v1.0.3) (2026-11-13)

### Styling

* **chat:** set fixed 20px bottom padding for mobile composer ([77d257d](https://github.com/tunghuynh/remote-cli/commit/77d257d167ff727a69811b808d94d362cf36b6e2))

### Maintenance

* update branding to RemoteCLI, author metadata and docs ([ff8e649](https://github.com/tunghuynh/remote-cli/commit/ff8e6498258def9507d7aa2ab98b81dc18a73de4))

# Changelog

All notable changes to CloudCLI UI will be documented in this file.


## [1.37.7](https://github.com/siteboon/claudecodeui/compare/v1.37.6...v1.37.7) (2026-10-31)

### New Features

* **browser-use:** let the user click and type in the Browser panel ([#1571](https://github.com/siteboon/claudecodeui/issues/1571)) ([a3a51d9](https://github.com/siteboon/claudecodeui/commit/a3a51d906ffb0906428f2fdbd13e2657441e96eb)), closes [#1570](https://github.com/siteboon/claudecodeui/issues/1570)
* **sidebar:** rename sessions by double-clicking their title ([#1693](https://github.com/siteboon/claudecodeui/issues/1693)) ([fc2de9f](https://github.com/siteboon/claudecodeui/commit/fc2de9ff5742865f0fc51d2dcebb44057120f58a))

### Bug Fixes

* **chat:** keep Enter a newline on on-screen keyboards ([#1602](https://github.com/siteboon/claudecodeui/issues/1602)) ([a11e469](https://github.com/siteboon/claudecodeui/commit/a11e469a56e143865de868ad46a1ce30152e7c14))
* **chat:** keep the composer buttons on one row as the token count grows ([#1683](https://github.com/siteboon/claudecodeui/issues/1683)) ([383e4f1](https://github.com/siteboon/claudecodeui/commit/383e4f1a67dd41e25a434770278d7707622cf8b4))
* **claude:** label SDK sessions as claudecodeui ([#1677](https://github.com/siteboon/claudecodeui/issues/1677)) ([154b3b1](https://github.com/siteboon/claudecodeui/commit/154b3b14d350a372dc085a62fa70f7e5e1810305))
* **sidebar:** offer session forking in the mobile options sheet ([#1597](https://github.com/siteboon/claudecodeui/issues/1597)) ([3491cf9](https://github.com/siteboon/claudecodeui/commit/3491cf9fa4262cf85bfffca4829d565ff959bcdf))

## [1.37.6](https://github.com/siteboon/claudecodeui/compare/v1.37.5...v1.37.6) (2026-10-27)

### New Features

* **chat:** name the permission mode in the composer ([#1631](https://github.com/siteboon/claudecodeui/issues/1631)) ([a82918c](https://github.com/siteboon/claudecodeui/commit/a82918cac9cde8bee79173b193002efdbe1f7a30)), closes [#1593](https://github.com/siteboon/claudecodeui/issues/1593)
* **i18n:** add Simplified and Traditional Chinese Git namespace ([#1653](https://github.com/siteboon/claudecodeui/issues/1653)) ([ba51f62](https://github.com/siteboon/claudecodeui/commit/ba51f627813fcf79c11ce9ec76782401d76f5b20))
* **i18n:** complete Spanish translations ([#1624](https://github.com/siteboon/claudecodeui/issues/1624)) ([7238368](https://github.com/siteboon/claudecodeui/commit/7238368fca24e90938e9a6736d38af8b86575eb9))
* **providers:** show installed CLI versions and update a CLI from Settings ([#1609](https://github.com/siteboon/claudecodeui/issues/1609)) ([bfb5319](https://github.com/siteboon/claudecodeui/commit/bfb531973a00fb3b1b77db18d9fa07de36390811)), closes [#1529](https://github.com/siteboon/claudecodeui/issues/1529)
* **sidebar:** optionally remember expanded projects ([#1648](https://github.com/siteboon/claudecodeui/issues/1648)) ([97560f1](https://github.com/siteboon/claudecodeui/commit/97560f12e4d2e62f9bb0bdbdc2884c7d960deecf))

### Bug Fixes

* **chat:** clear a background task chip whose task already ended ([#1657](https://github.com/siteboon/claudecodeui/issues/1657)) ([3fe5aaa](https://github.com/siteboon/claudecodeui/commit/3fe5aaa3e634da080cd3ffde670529b1f4ae7578)), closes [#1656](https://github.com/siteboon/claudecodeui/issues/1656)
* **chat:** keep every follow-up queued while a turn runs ([#1634](https://github.com/siteboon/claudecodeui/issues/1634)) ([527d2ea](https://github.com/siteboon/claudecodeui/commit/527d2ea8239b340ea396f90ad8e858f0eaed14f8)), closes [#1587](https://github.com/siteboon/claudecodeui/issues/1587) [#1587](https://github.com/siteboon/claudecodeui/issues/1587)
* **claude:** keep the Artifact tools in SDK-driven sessions ([#1647](https://github.com/siteboon/claudecodeui/issues/1647)) ([09e6106](https://github.com/siteboon/claudecodeui/commit/09e61067be9338efc7fc0b23f358414d3e47ca50))
* **claude:** type buildClaudeSdkEnv so the server build passes ([#1674](https://github.com/siteboon/claudecodeui/issues/1674)) ([cbdf8a4](https://github.com/siteboon/claudecodeui/commit/cbdf8a417527f2a73a687d133854bf7ec3c83180))
* **file-tree:** let the viewer read any file under the workspace root ([#1622](https://github.com/siteboon/claudecodeui/issues/1622)) ([80fbeac](https://github.com/siteboon/claudecodeui/commit/80fbeac124f917a9e67787777eb95a463582e62d))
* **scheduled-messages:** take a sent message's banner down without a reload ([#1613](https://github.com/siteboon/claudecodeui/issues/1613)) ([4edd7e9](https://github.com/siteboon/claudecodeui/commit/4edd7e940fa90d52fb3588aea269511f6d64ca2d)), closes [#1546](https://github.com/siteboon/claudecodeui/issues/1546) [#1546](https://github.com/siteboon/claudecodeui/issues/1546)
* **sessions:** make the session watcher's ignore list take effect again ([#1638](https://github.com/siteboon/claudecodeui/issues/1638)) ([e66cafc](https://github.com/siteboon/claudecodeui/commit/e66cafcb6129297060e612bcfccf867343828045)), closes [#1156](https://github.com/siteboon/claudecodeui/issues/1156)
* **sessions:** skip malformed JSONL lines instead of dropping the rest of the file ([#1643](https://github.com/siteboon/claudecodeui/issues/1643)) ([6780c08](https://github.com/siteboon/claudecodeui/commit/6780c0845c924f664243782ffd703f5e4097a690))
* **sidebar:** make "Load more sessions" fetch every time it is clicked ([#1629](https://github.com/siteboon/claudecodeui/issues/1629)) ([8d9bfbc](https://github.com/siteboon/claudecodeui/commit/8d9bfbcd0923019b53eedadf94567e3d79e21b9e)), closes [#1598](https://github.com/siteboon/claudecodeui/issues/1598) [#1598](https://github.com/siteboon/claudecodeui/issues/1598)

### Refactoring

* **claude:** migrate the runtime provider to TypeScript ([#1600](https://github.com/siteboon/claudecodeui/issues/1600)) ([7ccd6ab](https://github.com/siteboon/claudecodeui/commit/7ccd6ab9a1829f7e82e55a1e2a49bc0c4bf5dc2f))

## [1.37.5](https://github.com/siteboon/claudecodeui/compare/v1.37.4...v1.37.5) (2026-10-17)

### New Features

* **chat:** offer to queue a message behind a session's background work ([#1583](https://github.com/siteboon/claudecodeui/issues/1583)) ([82a2b62](https://github.com/siteboon/claudecodeui/commit/82a2b62a5e6085a41acb3ac908fa21e493ba43fd))
* **opencode:** show task calls as subagents ([#1443](https://github.com/siteboon/claudecodeui/issues/1443)) ([02e44b0](https://github.com/siteboon/claudecodeui/commit/02e44b016d43aadf3513ff2795e536df3817f4b4))
* **providers:** let a provider list only its custom models ([#1561](https://github.com/siteboon/claudecodeui/issues/1561)) ([abc14eb](https://github.com/siteboon/claudecodeui/commit/abc14eb27cc4b60b08535983953a9f6912205969)), closes [#1513](https://github.com/siteboon/claudecodeui/issues/1513)

### Bug Fixes

* **auth:** ignore auth headers replayed by cached responses ([#1549](https://github.com/siteboon/claudecodeui/issues/1549)) ([b26207a](https://github.com/siteboon/claudecodeui/commit/b26207ac5edd10c7558cf9894d151810b998257a))
* **claude:** measure the context window against the SDK-reported window ([#1557](https://github.com/siteboon/claudecodeui/issues/1557)) ([5d76a2d](https://github.com/siteboon/claudecodeui/commit/5d76a2d85d957912e7e9c83a25731d86d48162a5)), closes [#1505](https://github.com/siteboon/claudecodeui/issues/1505)
* **codex:** read inherited history in reference-backed forks ([#1530](https://github.com/siteboon/claudecodeui/issues/1530)) ([92ccebc](https://github.com/siteboon/claudecodeui/commit/92ccebc660749e63ba8f2b51fac3e3ba2c8b7462))
* **commands:** keep multi-line slash command arguments in $ARGUMENTS ([#1581](https://github.com/siteboon/claudecodeui/issues/1581)) ([d1a4929](https://github.com/siteboon/claudecodeui/commit/d1a49297dd3884c5c4299694d379e76be11be25f)), closes [#1523](https://github.com/siteboon/claudecodeui/issues/1523) [#1523](https://github.com/siteboon/claudecodeui/issues/1523) [#1523](https://github.com/siteboon/claudecodeui/issues/1523)
* **opencode:** discover models for connected providers ([#1578](https://github.com/siteboon/claudecodeui/issues/1578)) ([6c50659](https://github.com/siteboon/claudecodeui/commit/6c506597d677988bcddf9b79bee982ef05d9cad9))
* **plugins:** explain why a plugin git clone or pull failed ([#1562](https://github.com/siteboon/claudecodeui/issues/1562)) ([94da1c2](https://github.com/siteboon/claudecodeui/commit/94da1c221f15a377e9624753d8009ca35c3c06f7)), closes [#1511](https://github.com/siteboon/claudecodeui/issues/1511) [#1511](https://github.com/siteboon/claudecodeui/issues/1511)
* **sessions:** show pasted text instead of raw <pasted_content> tags ([#1504](https://github.com/siteboon/claudecodeui/issues/1504)) ([0753fc6](https://github.com/siteboon/claudecodeui/commit/0753fc6b3b9d46b243fdf5e8ada8a0a8932b3f7f))
* **sessions:** stop showing logged API requests as repeated messages ([#1596](https://github.com/siteboon/claudecodeui/issues/1596)) ([16311b6](https://github.com/siteboon/claudecodeui/commit/16311b635197bf8cff6a5ed7ceeeb9fba3a9960b))

### Documentation

* **plugins:** drop the Claude Watch plugin whose repository is gone ([#1577](https://github.com/siteboon/claudecodeui/issues/1577)) ([cfd2cc0](https://github.com/siteboon/claudecodeui/commit/cfd2cc0218cc44a2c6be741e5582b0242215df30)), closes [#1510](https://github.com/siteboon/claudecodeui/issues/1510)

## [1.37.4](https://github.com/siteboon/claudecodeui/compare/v1.37.3...v1.37.4) (2026-10-09)

### New Features

* **1188:** let the sidebar be resized ([#1189](https://github.com/siteboon/claudecodeui/issues/1189)) ([6c51fca](https://github.com/siteboon/claudecodeui/commit/6c51fcaa76c250af70561fad7312c5a7f841a733))
* **chat:** label each assistant reply with the model that answered it ([#1391](https://github.com/siteboon/claudecodeui/issues/1391)) ([7f4eba7](https://github.com/siteboon/claudecodeui/commit/7f4eba78c4dc887df9ca2c640e4ac6555996a426)), closes [#1059](https://github.com/siteboon/claudecodeui/issues/1059)
* **chat:** render workspace image paths in markdown ([#1307](https://github.com/siteboon/claudecodeui/issues/1307)) ([4b98d2e](https://github.com/siteboon/claudecodeui/commit/4b98d2eaec077470b737790b32e896051c5ff5ba))
* **chat:** say a compaction out loud, as one row with its summary folded in ([#1295](https://github.com/siteboon/claudecodeui/issues/1295)) ([d450ed8](https://github.com/siteboon/claudecodeui/commit/d450ed8521e71d731265021c75980656ab20c185)), closes [#1292](https://github.com/siteboon/claudecodeui/issues/1292)
* **codex:** add GPT-6 Sol and GPT-6 Luna models ([#1435](https://github.com/siteboon/claudecodeui/issues/1435)) ([48c8ae4](https://github.com/siteboon/claudecodeui/commit/48c8ae4c55075325c2f5ca81664db7b21d23f432)), closes [#1415](https://github.com/siteboon/claudecodeui/issues/1415)
* **git:** compare the working copy against any branch in Source Control ([#1369](https://github.com/siteboon/claudecodeui/issues/1369)) ([a2ed7f3](https://github.com/siteboon/claudecodeui/commit/a2ed7f3c85b04da01c8376e7a295e7740e4fe00b)), closes [#298](https://github.com/siteboon/claudecodeui/issues/298)
* **i18n:** add Brazilian Portuguese language support ([#1518](https://github.com/siteboon/claudecodeui/issues/1518)) ([6b2fdd8](https://github.com/siteboon/claudecodeui/commit/6b2fdd8ebd00474485bf3473135439a7772c9ca9))
* **i18n:** add Czech language support ([#1384](https://github.com/siteboon/claudecodeui/issues/1384)) ([7fb91f0](https://github.com/siteboon/claudecodeui/commit/7fb91f000ffc082f9eb73d5e49b80d80d830742c)), closes [#1328](https://github.com/siteboon/claudecodeui/issues/1328)
* **i18n:** add Hebrew language support ([#1509](https://github.com/siteboon/claudecodeui/issues/1509)) ([6f579b5](https://github.com/siteboon/claudecodeui/commit/6f579b5c77a8baa1af6a740a9fc1fe720a9f4b86))
* **i18n:** add Indonesian language support ([#1328](https://github.com/siteboon/claudecodeui/issues/1328)) ([b8e572b](https://github.com/siteboon/claudecodeui/commit/b8e572bdf919752aa17b521a2784341b7665beca))
* **plugins:** recommend Agent Monitor plugin ([#1474](https://github.com/siteboon/claudecodeui/issues/1474)) ([dc94683](https://github.com/siteboon/claudecodeui/commit/dc9468300404aefd88734157f574f9d751f37d64))
* **plugins:** recommend GLM Usage plugin ([#1323](https://github.com/siteboon/claudecodeui/issues/1323)) ([f05ba1f](https://github.com/siteboon/claudecodeui/commit/f05ba1fd6c6fc8cd0da180cee079fec66531a9bf))
* **providers:** let custom models declare reasoning-effort levels ([#1418](https://github.com/siteboon/claudecodeui/issues/1418)) ([51fb575](https://github.com/siteboon/claudecodeui/commit/51fb575793f7f5f66131282e0a3eb46062fd79ef)), closes [#1294](https://github.com/siteboon/claudecodeui/issues/1294)
* **quick-settings:** add Settings/Commands tabs and pin-to-dock to the right panel ([#1371](https://github.com/siteboon/claudecodeui/issues/1371)) ([9212ee3](https://github.com/siteboon/claudecodeui/commit/9212ee33618ad0daee9f3556b85c80f811637ffb)), closes [#508](https://github.com/siteboon/claudecodeui/issues/508)
* **sessions:** report turns driven by the Claude CLI as running ([#1394](https://github.com/siteboon/claudecodeui/issues/1394)) ([3cc73ed](https://github.com/siteboon/claudecodeui/commit/3cc73ede4cef51927de79d39b6e820e58cda050c))
* **settings:** close settings modal with escape and backdrop click ([#1164](https://github.com/siteboon/claudecodeui/issues/1164)) ([3ed3be5](https://github.com/siteboon/claudecodeui/commit/3ed3be5aa047b17ed1f6e591cfd3692eda2f1160))
* **settings:** let the theme follow the operating system appearance ([#1393](https://github.com/siteboon/claudecodeui/issues/1393)) ([87c44f5](https://github.com/siteboon/claudecodeui/commit/87c44f58edb1f091e9e060d159838df7e7b5626c))
* **settings:** show the permission rules from Claude's settings files (read-only) ([#1492](https://github.com/siteboon/claudecodeui/issues/1492)) ([4567700](https://github.com/siteboon/claudecodeui/commit/4567700825e3c1fa99010bdd95b5f5c42272c7de)), closes [#109](https://github.com/siteboon/claudecodeui/issues/109)
* **sidebar:** pin expanded project header while sessions scroll ([#1312](https://github.com/siteboon/claudecodeui/issues/1312)) ([b028e0d](https://github.com/siteboon/claudecodeui/commit/b028e0d886c059e6c4c21137e8dbe05068c8877f))
* **sidebar:** select and delete several of a project's sessions at once ([#1404](https://github.com/siteboon/claudecodeui/issues/1404)) ([f34ac83](https://github.com/siteboon/claudecodeui/commit/f34ac8342e953aeb457b11431912c8d8301e4154)), closes [#814](https://github.com/siteboon/claudecodeui/issues/814)
* **workspace:** rename a session by double-clicking its title in the chat header ([#1374](https://github.com/siteboon/claudecodeui/issues/1374)) ([09892b5](https://github.com/siteboon/claudecodeui/commit/09892b575bd1c85caf041fb86aa2b846df797c9b)), closes [#512](https://github.com/siteboon/claudecodeui/issues/512) [#512](https://github.com/siteboon/claudecodeui/issues/512)

### Bug Fixes

* **auth:** render the message of a structured error envelope ([#1425](https://github.com/siteboon/claudecodeui/issues/1425)) ([f24fa19](https://github.com/siteboon/claudecodeui/commit/f24fa191504fc0bade5e2607b79249738aa198e5)), closes [#1300](https://github.com/siteboon/claudecodeui/issues/1300)
* **auth:** stop token refreshes and language changes from remounting the app ([#1408](https://github.com/siteboon/claudecodeui/issues/1408)) ([dc7cb6c](https://github.com/siteboon/claudecodeui/commit/dc7cb6c6dcd22988f3241e10303298046ead351e)), closes [#1269](https://github.com/siteboon/claudecodeui/issues/1269)
* **chat:** Enter that confirms an IME candidate must not send on Safari ([#1332](https://github.com/siteboon/claudecodeui/issues/1332)) ([fd424f3](https://github.com/siteboon/claudecodeui/commit/fd424f3fcd739371daeb6b173167e61f95270670))
* **chat:** keep a queued message waiting while background work runs ([#1434](https://github.com/siteboon/claudecodeui/issues/1434)) ([80dd5c2](https://github.com/siteboon/claudecodeui/commit/80dd5c299e6f33c1a8b52761c00d418e6bfadfe7)), closes [#1334](https://github.com/siteboon/claudecodeui/issues/1334)
* **chat:** make in-chat file references land where they point ([#1256](https://github.com/siteboon/claudecodeui/issues/1256)) ([580be52](https://github.com/siteboon/claudecodeui/commit/580be52dacd3538f1b0ec6fee56aa02d793cd21a))
* **chat:** refetch the @ file list each time the dropdown opens ([#1411](https://github.com/siteboon/claudecodeui/issues/1411)) ([fce5c2e](https://github.com/siteboon/claudecodeui/commit/fce5c2e73f9d29d0afca5a490dfaf827f9bdbba7)), closes [#1367](https://github.com/siteboon/claudecodeui/issues/1367) [#1367](https://github.com/siteboon/claudecodeui/issues/1367)
* **chat:** render LaTeX \(…\) and \[…\] math in assistant messages ([#1385](https://github.com/siteboon/claudecodeui/issues/1385)) ([de0908b](https://github.com/siteboon/claudecodeui/commit/de0908b079cfe9bf07a0247211dcf144cc850e4c)), closes [#1123](https://github.com/siteboon/claudecodeui/issues/1123)
* **chat:** send a new chat's first message to one session only ([#1420](https://github.com/siteboon/claudecodeui/issues/1420)) ([bb81d0b](https://github.com/siteboon/claudecodeui/commit/bb81d0b039b9e13fca49cda4f495c6736f79779f)), closes [#1306](https://github.com/siteboon/claudecodeui/issues/1306)
* **chat:** show what a Bash command changed under its command row ([#1483](https://github.com/siteboon/claudecodeui/issues/1483)) ([d392d9e](https://github.com/siteboon/claudecodeui/commit/d392d9eba24f82f60a3e08946ed036d65a263e3c)), closes [#1455](https://github.com/siteboon/claudecodeui/issues/1455) [#1455](https://github.com/siteboon/claudecodeui/issues/1455)
* **chat:** show when the chat connection is lost ([#1485](https://github.com/siteboon/claudecodeui/issues/1485)) ([d4dd34d](https://github.com/siteboon/claudecodeui/commit/d4dd34da1fcab568afefc257e40c14771f076322)), closes [#582](https://github.com/siteboon/claudecodeui/issues/582)
* **chat:** stop lazy transcript rows flickering at the band edge ([#1421](https://github.com/siteboon/claudecodeui/issues/1421)) ([6c8e8be](https://github.com/siteboon/claudecodeui/commit/6c8e8be7f0e9610f47c5a341107d111204ead02e)), closes [#1357](https://github.com/siteboon/claudecodeui/issues/1357)
* **chat:** Tab completes a slash command instead of running it ([#1380](https://github.com/siteboon/claudecodeui/issues/1380)) ([eef9791](https://github.com/siteboon/claudecodeui/commit/eef9791ea34d69c8f88121f52162755fcbe78ee5))
* **claude:** hold the CLI open for backgrounded agents and workflows ([#1291](https://github.com/siteboon/claudecodeui/issues/1291)) ([208c715](https://github.com/siteboon/claudecodeui/commit/208c71560278f7f9607847c0595803a683de2864)), closes [#1113](https://github.com/siteboon/claudecodeui/issues/1113) [#1268](https://github.com/siteboon/claudecodeui/issues/1268)
* **claude:** show session titles instead of prompts in the sidebar ([#1258](https://github.com/siteboon/claudecodeui/issues/1258)) ([7704a90](https://github.com/siteboon/claudecodeui/commit/7704a90523ec6fb9514b2d251db1b18046517f2e))
* **claude:** stop a held run's background tasks before a new turn takes over ([#1395](https://github.com/siteboon/claudecodeui/issues/1395)) ([b9d3d12](https://github.com/siteboon/claudecodeui/commit/b9d3d1299ae946c11e75d06db7409e9e4d402e49)), closes [#884](https://github.com/siteboon/claudecodeui/issues/884)
* **code-editor:** confirm before discarding unsaved changes ([#1409](https://github.com/siteboon/claudecodeui/issues/1409)) ([05b6306](https://github.com/siteboon/claudecodeui/commit/05b6306015bcaa1fd7f583b00a458f78082d1655)), closes [#870](https://github.com/siteboon/claudecodeui/issues/870)
* **codex:** restore user prompts from canonical typed rollout rows ([#1277](https://github.com/siteboon/claudecodeui/issues/1277)) ([5ce8ed4](https://github.com/siteboon/claudecodeui/commit/5ce8ed4537eb71397885a8a180e1d5090aa3bc2d))
* **codex:** support image-only prompts ([#1346](https://github.com/siteboon/claudecodeui/issues/1346)) ([a6d50c8](https://github.com/siteboon/claudecodeui/commit/a6d50c84ca5f16872c4166fc4772af2dc8687e6b))
* **cursor:** stop reporting fresh logins as "Command timeout" ([#1494](https://github.com/siteboon/claudecodeui/issues/1494)) ([272a108](https://github.com/siteboon/claudecodeui/commit/272a10884a5a11e30667888318439b324895549b)), closes [#551](https://github.com/siteboon/claudecodeui/issues/551) [#551](https://github.com/siteboon/claudecodeui/issues/551)
* **desktop:** keep the app view sized to the window after maximize ([#1405](https://github.com/siteboon/claudecodeui/issues/1405)) ([4cd470f](https://github.com/siteboon/claudecodeui/commit/4cd470fac4d011dacab2a564272a0f72927396dc)), closes [#1194](https://github.com/siteboon/claudecodeui/issues/1194)
* **opencode:** compose the provider prefix into session model ids ([#1333](https://github.com/siteboon/claudecodeui/issues/1333)) ([544baff](https://github.com/siteboon/claudecodeui/commit/544baffe3c02106abb443f5c5f0b2b3d2bdc7b6b))
* **opencode:** hide child sessions ([#1344](https://github.com/siteboon/claudecodeui/issues/1344)) ([ed3f0bf](https://github.com/siteboon/claudecodeui/commit/ed3f0bfc0a45ee0b3aaddfd04de241c29335ff42))
* **providers:** strip ANSI escapes from OpenCode and Cursor stderr ([#1303](https://github.com/siteboon/claudecodeui/issues/1303)) ([f362080](https://github.com/siteboon/claudecodeui/commit/f36208036efd5aef8dbfd92d3f0db18986f45530))
* recover background-agent results and status, read-only temp browsing, clone-token redaction ([#1347](https://github.com/siteboon/claudecodeui/issues/1347)) ([557109a](https://github.com/siteboon/claudecodeui/commit/557109a2e98e833ad9cb6659ec89e97ccacdd024))
* **sessions:** show the Claude branch a resume will replay ([#1148](https://github.com/siteboon/claudecodeui/issues/1148)) ([#1378](https://github.com/siteboon/claudecodeui/issues/1378)) ([d1b0933](https://github.com/siteboon/claudecodeui/commit/d1b093303755236d48a3bd2402e24862413c39ef))
* **settings:** warn when an api key is bypassing the claude subscription login ([#1375](https://github.com/siteboon/claudecodeui/issues/1375)) ([c6468e1](https://github.com/siteboon/claudecodeui/commit/c6468e1311057cff3fb879dbad6376429f4338ed))
* **shell:** make the shell tab follow the light/dark theme ([#1428](https://github.com/siteboon/claudecodeui/issues/1428)) ([6828313](https://github.com/siteboon/claudecodeui/commit/6828313154523b5de9e2d37227189319f9281c04)), closes [#1335](https://github.com/siteboon/claudecodeui/issues/1335) [#1335](https://github.com/siteboon/claudecodeui/issues/1335)
* **sidebar:** let Running collapse project groups ([#1166](https://github.com/siteboon/claudecodeui/issues/1166)) ([7090a5d](https://github.com/siteboon/claudecodeui/commit/7090a5dbfdee7f0fae5fb17232300148c1963b94))
* upstream electron build bug ([5e73a49](https://github.com/siteboon/claudecodeui/commit/5e73a49b89b4f13766fc2e22723297a36e7dcef2))

### Performance

* **chat:** keep collapsed tool groups memoized across stream ticks ([#1386](https://github.com/siteboon/claudecodeui/issues/1386)) ([3576232](https://github.com/siteboon/claudecodeui/commit/3576232e03e7cd6f7097a045b9b9fa196c90d31d)), closes [#1050](https://github.com/siteboon/claudecodeui/issues/1050)

### Documentation

* add Indonesian README ([#1468](https://github.com/siteboon/claudecodeui/issues/1468)) ([5fd3de6](https://github.com/siteboon/claudecodeui/commit/5fd3de63573ce5e50496da177bdfff5b9110d945))

## [1.37.3](https://github.com/siteboon/claudecodeui/compare/v1.37.2...v1.37.3) (2026-09-08)

### New Features

* **chat:** recall sent messages with arrow keys in the composer ([#1238](https://github.com/siteboon/claudecodeui/issues/1238)) ([8f9a2e4](https://github.com/siteboon/claudecodeui/commit/8f9a2e43859821e9c41e4d90b8d16707f47927de))
* **chat:** unify provider workflows and improve transcript performance ([#1206](https://github.com/siteboon/claudecodeui/issues/1206)) ([99ea052](https://github.com/siteboon/claudecodeui/commit/99ea05259554c166fccab9e20dcf902f435fa54d))
* **codex:** expose GPT-6 Astra model ([#1289](https://github.com/siteboon/claudecodeui/issues/1289)) ([4e1190c](https://github.com/siteboon/claudecodeui/commit/4e1190ccec899aebeac898409e5cbd32e0cde647))
* **i18n:** connect remaining hardcoded UI strings to translations ([#1192](https://github.com/siteboon/claudecodeui/issues/1192)) ([5af0990](https://github.com/siteboon/claudecodeui/commit/5af0990386953e00b71c72d326e25b874d30a800))
* **sidebar:** draw a Conversations row the way a Projects row is drawn ([#1157](https://github.com/siteboon/claudecodeui/issues/1157)) ([7015ffc](https://github.com/siteboon/claudecodeui/commit/7015ffc8447b2de228f3d942585d29f4a9aeb955)), closes [#1206](https://github.com/siteboon/claudecodeui/issues/1206)

### Bug Fixes

* **agent:** read the model catalog's own shape, not a wrapper ([#1159](https://github.com/siteboon/claudecodeui/issues/1159)) ([25ddd76](https://github.com/siteboon/claudecodeui/commit/25ddd76820b5147a46d5b08d53f5d1f31e14d35a))
* **chat:** keep an option label containing ", " as one answer ([#1249](https://github.com/siteboon/claudecodeui/issues/1249)) ([61af329](https://github.com/siteboon/claudecodeui/commit/61af3295441581ecc7be70579af95fc046931a68))
* **claude:** ignore <synthetic> model placeholder when resolving session model ([#1207](https://github.com/siteboon/claudecodeui/issues/1207)) ([7b52e3c](https://github.com/siteboon/claudecodeui/commit/7b52e3ce1c8f0069f3f501bf56ad73b55f9bc7da))
* **editor:** syntax highlighting for .mts, .cts, .mjs and .cjs ([#1223](https://github.com/siteboon/claudecodeui/issues/1223)) ([aa2755b](https://github.com/siteboon/claudecodeui/commit/aa2755b852965b27e764f42120062966f9916502))
* **i18n:** add missing delete-dialog archive keys to all locales ([#1162](https://github.com/siteboon/claudecodeui/issues/1162)) ([1c61dc3](https://github.com/siteboon/claudecodeui/commit/1c61dc302ed556b5455255e6e1726eb2ab12e853))
* npm release it and README ([d27062e](https://github.com/siteboon/claudecodeui/commit/d27062ed2927d048195b88fa5bf54dc520bba49c))
* npm release-it and README ([125a293](https://github.com/siteboon/claudecodeui/commit/125a293f2a9315e1e60cc8805fa4d007fee7f7d7))
* **opencode:** list OpenCode Go models with reasoning variants ([#1265](https://github.com/siteboon/claudecodeui/issues/1265)) ([b7320c9](https://github.com/siteboon/claudecodeui/commit/b7320c91d197ef64d505312797cd5f7b21f5d705)), closes [#840](https://github.com/siteboon/claudecodeui/issues/840)
* **release:** expose npm publish failures ([#1271](https://github.com/siteboon/claudecodeui/issues/1271)) ([46973fc](https://github.com/siteboon/claudecodeui/commit/46973fc962e63ed31983689e50fe75f921745cda))
* **scheduled-messages:** interrupt a busy run instead of failing to send ([#1239](https://github.com/siteboon/claudecodeui/issues/1239)) ([c1be241](https://github.com/siteboon/claudecodeui/commit/c1be241bc41586478f3d15f4dc6a5a6399d40aa1))
* **sessions:** keep an archived session archived across a rescan ([#1220](https://github.com/siteboon/claudecodeui/issues/1220)) ([bfe7c49](https://github.com/siteboon/claudecodeui/commit/bfe7c495792b21f027f057f555c39e2edb24d095))
* **skills:** a plugin that ships commands keeps its skills too ([#1274](https://github.com/siteboon/claudecodeui/issues/1274)) ([b6083e0](https://github.com/siteboon/claudecodeui/commit/b6083e0bc84ea5d8063191a057c52b0f4b0088c9)), closes [#1273](https://github.com/siteboon/claudecodeui/issues/1273)

## [1.37.2](https://github.com/siteboon/claudecodeui/compare/v1.37.1...v1.37.2) (2026-08-18)

### Bug Fixes

* improve chat view and resolve bandwidth issue ([#1153](https://github.com/siteboon/claudecodeui/issues/1153)) ([0a2ad34](https://github.com/siteboon/claudecodeui/commit/0a2ad34365b7f01dcd01b87fe3f856844c0dc531))
* introduce fallback for update build failures ([0d51774](https://github.com/siteboon/claudecodeui/commit/0d5177491215c1c2a53ad23a30f7deec8de2e1af))

## [1.37.1](https://github.com/siteboon/claudecodeui/compare/v1.37.0...v1.37.1) (2026-08-13)

### New Features

* add provider session ID copy actions ([#1040](https://github.com/siteboon/claudecodeui/issues/1040)) ([428b105](https://github.com/siteboon/claudecodeui/commit/428b1052be3bb28611d2ef3fcd29cec5a9ca1397))
* **i18n:** add complete Spanish (es) translation ([#1090](https://github.com/siteboon/claudecodeui/issues/1090)) ([5fa87dd](https://github.com/siteboon/claudecodeui/commit/5fa87ddaf7c1c06c33c34f48a462743aa3877edf))
* **i18n:** complete Korean (ko) translation ([#997](https://github.com/siteboon/claudecodeui/issues/997)) ([59472c0](https://github.com/siteboon/claudecodeui/commit/59472c075eb2f28a48df9d9eff659ad823d31bd2))
* **plugins:** recommend Codex Usage plugin ([#1114](https://github.com/siteboon/claudecodeui/issues/1114)) ([ca92373](https://github.com/siteboon/claudecodeui/commit/ca92373dfead92f7f777093e72e9a118a97ff97a))
* **sidebar:** add recent conversation feed ([#1041](https://github.com/siteboon/claudecodeui/issues/1041)) ([015e892](https://github.com/siteboon/claudecodeui/commit/015e892c75e29b1771399691dbca3c8b466fa0b1))

### Bug Fixes

* **claude:** remove dead CLAUDE_CODE_STREAM_CLOSE_TIMEOUT workaround ([#1115](https://github.com/siteboon/claudecodeui/issues/1115)) ([ef3f798](https://github.com/siteboon/claudecodeui/commit/ef3f7980db15c89761c3a1aad8b608fff33789ad))
* don't recurse into system directories when building file trees ([#1074](https://github.com/siteboon/claudecodeui/issues/1074)) ([753a8c0](https://github.com/siteboon/claudecodeui/commit/753a8c0422685bafd4e878c44726f727357a3fb5))
* resolve @/ path aliases so the server test suite can load ([#1084](https://github.com/siteboon/claudecodeui/issues/1084)) ([74d3f8f](https://github.com/siteboon/claudecodeui/commit/74d3f8ffff6f315d2f2ceb240512aeb2d8b40464))
* **search:** match Claude transcripts by provider_session_id ([#1078](https://github.com/siteboon/claudecodeui/issues/1078)) ([9507694](https://github.com/siteboon/claudecodeui/commit/95076941533dc14f04d83917e1e7c04229e664c1))
* tolerate client clock skew before treating an auth token as expired ([#1085](https://github.com/siteboon/claudecodeui/issues/1085)) ([f0dca2d](https://github.com/siteboon/claudecodeui/commit/f0dca2d5e79c225f599e697bf9b55e839b152b78))
* update stale Sonnet 4.6 labels to Sonnet 5 in the Claude model picker ([#1036](https://github.com/siteboon/claudecodeui/issues/1036)) ([c2408f0](https://github.com/siteboon/claudecodeui/commit/c2408f0fc331fb267fdc9def954e55f71d019302))

## [1.37.0](https://github.com/siteboon/claudecodeui/compare/v1.36.3...v1.37.0) (2026-07-29)

### New Features

* numerous bugfixes and features ([#1037](https://github.com/siteboon/claudecodeui/issues/1037)) ([06e7ee9](https://github.com/siteboon/claudecodeui/commit/06e7ee9fb8c6afd1066566e8dc0e2c0c853a4990))

### Bug Fixes

* check CLAUDE_CODE_OAUTH_TOKEN in checkCredentials() ([#979](https://github.com/siteboon/claudecodeui/issues/979)) ([75ff8a5](https://github.com/siteboon/claudecodeui/commit/75ff8a5dcd0d63dced4c662bbf9433d7515d09da))

## [1.36.3](https://github.com/siteboon/claudecodeui/compare/v1.36.2...v1.36.3) (2026-07-15)

### Bug Fixes

* codex subagents should not appear in the sidebar ([283b558](https://github.com/siteboon/claudecodeui/commit/283b5586d2a6704d93ab7d0627ee947f8fef9809))
* remove node_env from electron ([f2a95d6](https://github.com/siteboon/claudecodeui/commit/f2a95d64982c3372abfb9ff144244c2383476bd3))

### Maintenance

* refresh better-sqlite3 lock ([#1027](https://github.com/siteboon/claudecodeui/issues/1027)) ([31645e3](https://github.com/siteboon/claudecodeui/commit/31645e3fdc63857d9970eae8abef8ecbc5122796))

## [1.36.2](https://github.com/siteboon/claudecodeui/compare/v1.36.1...v1.36.2) (2026-07-14)

### Bug Fixes

* bump @openai/codex-sdk to ^0.144.0 to support newer Codex models ([#1001](https://github.com/siteboon/claudecodeui/issues/1001)) ([038d960](https://github.com/siteboon/claudecodeui/commit/038d960c75b547f111751a39f28689ac66fca76d))
* harden docker cloudcli install ([123d244](https://github.com/siteboon/claudecodeui/commit/123d244a5143c3954d2f1c54240a5e683ca74a4e))
* validate X-Refreshed-Token before storing it as the auth token ([#971](https://github.com/siteboon/claudecodeui/issues/971)) ([5884573](https://github.com/siteboon/claudecodeui/commit/5884573a6975f53381759a28280afd9c8bb332c4))

## [1.36.1](https://github.com/siteboon/claudecodeui/compare/v1.36.0...v1.36.1) (2026-07-08)

### New Features

* **redesign:** skills and MCP action controls in settings ([#942](https://github.com/siteboon/claudecodeui/issues/942)) ([41e0d30](https://github.com/siteboon/claudecodeui/commit/41e0d309e06edda14abc6912ade5c2f9d4a90984))

## [](https://github.com/siteboon/claudecodeui/compare/v1.35.1...vnull) (2026-07-03)

### New Features

* add Claude and Codex effort controls ([#943](https://github.com/siteboon/claudecodeui/issues/943)) ([d272922](https://github.com/siteboon/claudecodeui/commit/d272922d87e4ee74bf8b0fdeac83b2c1e77973f3))

## [1.35.1](https://github.com/siteboon/claudecodeui/compare/v1.35.0...v1.35.1) (2026-07-01)

### Bug Fixes

* preview video on new tab ([#933](https://github.com/siteboon/claudecodeui/issues/933)) ([2ebe64f](https://github.com/siteboon/claudecodeui/commit/2ebe64f21874f45f6c8747310be874ae7342c61c))
* remove obsolete semantic helper release jobs ([1e16f1f](https://github.com/siteboon/claudecodeui/commit/1e16f1f0854e347aa333434638d64f2b167d9a9d))
* resolve mobile shell issues ([#923](https://github.com/siteboon/claudecodeui/issues/923)) ([b6cf333](https://github.com/siteboon/claudecodeui/commit/b6cf33308da996f8169580a4b5b74e3c5f38e447))

### Maintenance

* remove computer use ([6761f31](https://github.com/siteboon/claudecodeui/commit/6761f31a56fe82d82c7e0c079b4891e7d5a81817))

## [1.35.0](https://github.com/siteboon/claudecodeui/compare/v1.34.0...v1.35.0) (2026-06-29)

### New Features

* add Electron desktop app ([97c9b67](https://github.com/siteboon/claudecodeui/commit/97c9b67bfc2d803560cd1559a4e79eea9731c7b5))
* **chat:** derive activity indicator from per-session state and unify provider lifecycle events ([afc717e](https://github.com/siteboon/claudecodeui/commit/afc717e69e67f53173c30d2230722236f9180d39))
* **chat:** unify session gateway with stable IDs and a single WS protocol ([f5eac2e](https://github.com/siteboon/claudecodeui/commit/f5eac2ec12c8575bf80202fafe807d9e04720105))
* **i18n:** add French (fr) locale ([#878](https://github.com/siteboon/claudecodeui/issues/878)) ([f319d2c](https://github.com/siteboon/claudecodeui/commit/f319d2cf8d61452deaf6adf345494dd3e6898284))
* play sound for pending tool requests ([#918](https://github.com/siteboon/claudecodeui/issues/918)) ([c947eaa](https://github.com/siteboon/claudecodeui/commit/c947eaaee5fbc959563efb917f4ec7c88847dd6b))
* render changelog as markdown in version upgrade modal ([6a53c31](https://github.com/siteboon/claudecodeui/commit/6a53c31e907fffa79320997c27f99660c946b4a6))
* **sidebar:** improve running session state tracking ([591b18e](https://github.com/siteboon/claudecodeui/commit/591b18e9e343fda23affe100a53911f76aaa8f57))
* **skills:** add provider skill management ([#909](https://github.com/siteboon/claudecodeui/issues/909)) ([c5fe127](https://github.com/siteboon/claudecodeui/commit/c5fe127958d830eee19d008d8634c0e7d77fe1b9))
* **version:** warn when the server was updated but not restarted ([#898](https://github.com/siteboon/claudecodeui/issues/898)) ([f6326c8](https://github.com/siteboon/claudecodeui/commit/f6326c8082dfbe8a65dcdb836d3e71c635594c26))

### Bug Fixes

* changes provider logos to svg for fast load ([7bed675](https://github.com/siteboon/claudecodeui/commit/7bed675ad5fd1ecf7912d1a04afe9db5b1032823))
* **chat:** prevent chat interface crash on malformed AskUserQuestion payload ([#920](https://github.com/siteboon/claudecodeui/issues/920)) ([ed4ae31](https://github.com/siteboon/claudecodeui/commit/ed4ae3114aafc1d4ecb0b621eaf9d3b26dbca5b1))
* **chat:** prevent normalizeInlineCodeFences from breaking adjacent fenced code blocks ([#903](https://github.com/siteboon/claudecodeui/issues/903)) ([4712431](https://github.com/siteboon/claudecodeui/commit/4712431be81718dfb559ef43d7d7d5315bf4e01a))
* **chat:** sort messages appropriately ([123ae31](https://github.com/siteboon/claudecodeui/commit/123ae310207fe5969c3b313f62b9dee27e5d7489))
* **claude-sync:** skip subagent transcripts to prevent main session corruption ([#854](https://github.com/siteboon/claudecodeui/issues/854)) ([a12ca8e](https://github.com/siteboon/claudecodeui/commit/a12ca8eed373ef56cd37fbdd097845eaab34dee9))
* correct notification session id ([881e72d](https://github.com/siteboon/claudecodeui/commit/881e72d4a00ec9c1a5e1ae4799bffa900f27c1f8))
* create one unified function for frontend session processing ([677d330](https://github.com/siteboon/claudecodeui/commit/677d330981ef29a856f09e62b9f69bac0fa580d4))
* **i18n:** add missing sidebar message keys to all locales ([#896](https://github.com/siteboon/claudecodeui/issues/896)) ([7ca3556](https://github.com/siteboon/claudecodeui/commit/7ca355651f0a805965bc27af3d75def626c5fb96))
* keep running-session polling active ([39b0473](https://github.com/siteboon/claudecodeui/commit/39b0473e38201c29ff1e5388946452d2eed44527))
* normalize project session payloads ([d0adddb](https://github.com/siteboon/claudecodeui/commit/d0adddbbdafecfd5713a8ac5b95c87a8f7fc54f8))
* **opencode:** bind watcher sessions to app rows early ([5b9adbb](https://github.com/siteboon/claudecodeui/commit/5b9adbbdee8561439a27ad90744388225823427b))
* **opencode:** pass workspace dir explicitly ([416a737](https://github.com/siteboon/claudecodeui/commit/416a737d76e654d2fc649206c2b921a7db150775))
* recover pending permission requests ([56b2e14](https://github.com/siteboon/claudecodeui/commit/56b2e1405967c50301d0c773567349763edc8560))
* remove provider specific token usage calculator ([2abb456](https://github.com/siteboon/claudecodeui/commit/2abb45636b5e1109733cfa58c8ab92fd4c812165))
* resolve session provider on backend reads ([9fb2d91](https://github.com/siteboon/claudecodeui/commit/9fb2d91b26bef9579337d953a29718802c466fed))
* **sessions:** canonicalize sidebar ids and timestamps ([3bbb42c](https://github.com/siteboon/claudecodeui/commit/3bbb42c23324c3cbb5587f2bcab09b1dc23086a8))
* **shell:** prioritize user npm binaries ([#913](https://github.com/siteboon/claudecodeui/issues/913)) ([4a503b1](https://github.com/siteboon/claudecodeui/commit/4a503b1dc87ff58821670c8bfb1d8a8c1dab2bcf))
* **shell:** use correct session id ([89f0524](https://github.com/siteboon/claudecodeui/commit/89f05247eddec4fe53bd1616c6a5563e3ae2427a))
* **sidebar:** align session status controls across layouts ([1b336e9](https://github.com/siteboon/claudecodeui/commit/1b336e9aa9d2cccf0676d852815d9ba613ac04d2))
* upgrade gemini logo ([9cb2afd](https://github.com/siteboon/claudecodeui/commit/9cb2afd67eb25a4f869b88abcf86f7748b2b6d71))
* voice tts format settings ([#919](https://github.com/siteboon/claudecodeui/issues/919)) ([591e8e7](https://github.com/siteboon/claudecodeui/commit/591e8e7642589b0584f9b29b46b881aaab54624e))

### Documentation

* update available plugin readmes ([f549bd9](https://github.com/siteboon/claudecodeui/commit/f549bd99e7106362a27cf4ccee6e9d434b8b5363))
* update session activity guard comment ([e23e6af](https://github.com/siteboon/claudecodeui/commit/e23e6af06a44cc4b016df5778984602d49e52629))

### Maintenance

* add github issues board plugin ([21b0f14](https://github.com/siteboon/claudecodeui/commit/21b0f14e7a86f257c65484742c43b9f85152b32c))
* add more plugins list ([bc34085](https://github.com/siteboon/claudecodeui/commit/bc34085af9912da8d8592881a5845cff84a53f7d))
* move tests to appropriate folder ([d7a38a5](https://github.com/siteboon/claudecodeui/commit/d7a38a567a5e9039935353a886310b3c32b25a79))
* move tests to appropriate folder ([c6c153e](https://github.com/siteboon/claudecodeui/commit/c6c153e7f2a60572b08d687b59f010b4ad4f5d72))
* remove a log ([00e526b](https://github.com/siteboon/claudecodeui/commit/00e526b6e90ee0baf09ebf48873bc10824ab80ba))
* remove unused modelConstants from the project ([92de0ed](https://github.com/siteboon/claudecodeui/commit/92de0ed6137bf4571056deb3b930cc9fd22e2a08))
* upgrade gemini models ([3d94821](https://github.com/siteboon/claudecodeui/commit/3d948217ef3084e764171ebc5dda55f663150b2c))

## [](https://github.com/siteboon/claudecodeui/compare/v1.33.3...vnull) (2026-06-09)

### New Features

* adding Fable 5 in claude code ([ce327b6](https://github.com/siteboon/claudecodeui/commit/ce327b6fa9329aa3e9a3a1da7225ca01d3b06ac5))

## [1.33.3](https://github.com/siteboon/claudecodeui/compare/v1.33.2...v1.33.3) (2026-06-09)

### New Features

* add file tree upload progress ([c235b05](https://github.com/siteboon/claudecodeui/commit/c235b05e1d3b626667dba4043b685512e3cd3d5d))
* signal when chat runs complete ([d70dc07](https://github.com/siteboon/claudecodeui/commit/d70dc077bfbbfcf2ff4fa5514fabf7b4485861fa))

### Bug Fixes

* address notification review feedback ([602e6ad](https://github.com/siteboon/claudecodeui/commit/602e6ad4acba612a7ea66fb3bc7485054f5675ee))
* align prism plugin name and id with manifest.json ([ca8fd0e](https://github.com/siteboon/claudecodeui/commit/ca8fd0ee235b6a3210157bd0d9af83024d4a2248))
* **chat:** re-anchor initial scroll across lazy content reflow ([33a4e72](https://github.com/siteboon/claudecodeui/commit/33a4e72ca4f84df60aadfc4ff3f3467d6f5ae948))
* keep editor toolbar in view on long unwrapped lines ([beae8c6](https://github.com/siteboon/claudecodeui/commit/beae8c6513daa7518b9de40d8bfde3bf08e7bc87))
* **sandbox:** prevent server SIGHUP on sbx exec exit ([#792](https://github.com/siteboon/claudecodeui/issues/792)) ([f4a1614](https://github.com/siteboon/claudecodeui/commit/f4a1614a0a4ab4b65e8368d5e4221f015cb7555d)), closes [#791](https://github.com/siteboon/claudecodeui/issues/791)
* slash command suggestions trigger at any / in input, not only at start ([#843](https://github.com/siteboon/claudecodeui/issues/843)) ([f7c0024](https://github.com/siteboon/claudecodeui/commit/f7c0024fe15057ad049c71e15e88adb482a4497f))
* update naming convention ([3cd8995](https://github.com/siteboon/claudecodeui/commit/3cd89956ba06f0fc3e17d349b0c50baab4012658))

### Maintenance

* add prism plugin ([01dbe2a](https://github.com/siteboon/claudecodeui/commit/01dbe2a8bfcb3b265995f01f905b218d5f576f7b))

## [1.33.2](https://github.com/siteboon/claudecodeui/compare/v1.33.1...v1.33.2) (2026-06-08)

### New Features

* **chat:** open cost modal from token usage ([f238050](https://github.com/siteboon/claudecodeui/commit/f238050b85c3b99a702a8635059735e1a3b3a4f4))
* **i18n:** add Traditional Chinese (zh-TW) locale ([#773](https://github.com/siteboon/claudecodeui/issues/773)) ([c21a9f4](https://github.com/siteboon/claudecodeui/commit/c21a9f45610eb1eeb650d8e6cf8650e798f77f6f))

### Bug Fixes

* do not show model description in chat view ([d638a89](https://github.com/siteboon/claudecodeui/commit/d638a8982c7f75b08fc7f65f01d6d54989c790d1))
* include Claude cache tokens in usage ([ed9cdf0](https://github.com/siteboon/claudecodeui/commit/ed9cdf01145fa0d063580bb76d30cfa7ee67af86))

## [1.33.1](https://github.com/siteboon/claudecodeui/compare/v1.33.0...v1.33.1) (2026-06-05)

### New Features

* **chat:** auto-detect text direction for RTL languages ([#729](https://github.com/siteboon/claudecodeui/issues/729)) ([fa9eaf5](https://github.com/siteboon/claudecodeui/commit/fa9eaf5573a6f870a19fb62ab430ffd87c466582))

### Bug Fixes

* file tree concurrency ([#828](https://github.com/siteboon/claudecodeui/issues/828)) ([ebb0e59](https://github.com/siteboon/claudecodeui/commit/ebb0e59e8023c0a8040d168a5adffb7102e80561))
* load claude models directly from provider ([cdcac18](https://github.com/siteboon/claudecodeui/commit/cdcac182d458a24908777568979c8e756f94428c))
* plugin svg icon sanitization ([#817](https://github.com/siteboon/claudecodeui/issues/817)) ([d9e9df1](https://github.com/siteboon/claudecodeui/commit/d9e9df183f462c88c3b60975eb8254faa9168717))
* recognize claude auth token env ([#818](https://github.com/siteboon/claudecodeui/issues/818)) ([43c33d5](https://github.com/siteboon/claudecodeui/commit/43c33d5cb1b41835dfe3bccd450c5a9c2441509b))
* redact websocket auth token in logs ([#827](https://github.com/siteboon/claudecodeui/issues/827)) ([14ddbc7](https://github.com/siteboon/claudecodeui/commit/14ddbc7c57a01da9fb65fd87d8588532b11833fa))
* remove thinking mode ([#835](https://github.com/siteboon/claudecodeui/issues/835)) ([2149b87](https://github.com/siteboon/claudecodeui/commit/2149b8776b7ebfec0eace413f4fc527ccb2324c0))
* **shell:** disconnect and restart buttons ([#831](https://github.com/siteboon/claudecodeui/issues/831)) ([ef2fd48](https://github.com/siteboon/claudecodeui/commit/ef2fd48b46452d4b9e2bf1f5e3c30fafe19f27f2))
* show Claude tool result errors ([bb8db58](https://github.com/siteboon/claudecodeui/commit/bb8db5815c2d20ee4fbfa02d14c886a56ef352e0))
* **vite:** proxy /plugin-ws WebSocket requests to the backend in dev ([#757](https://github.com/siteboon/claudecodeui/issues/757)) ([96b16b4](https://github.com/siteboon/claudecodeui/commit/96b16b42e4f807d04ec743a5a4117a37a3f5e0d9))
* **websocket:** add 30s server-side heartbeat to prevent proxy idle disconnects ([#770](https://github.com/siteboon/claudecodeui/issues/770)) ([2edfef2](https://github.com/siteboon/claudecodeui/commit/2edfef2e3f4271c29ae8670df9dd382a9eef7c3c)), closes [#769](https://github.com/siteboon/claudecodeui/issues/769)
* **websocket:** reset unmountedRef on each effect re-run so token refresh reconnects ([#721](https://github.com/siteboon/claudecodeui/issues/721)) ([f082cdc](https://github.com/siteboon/claudecodeui/commit/f082cdc63bd0de90f8b3da1df6071e91ab545831))

### Documentation

* add nginx subpath deployment template ([#820](https://github.com/siteboon/claudecodeui/issues/820)) ([3ec76b5](https://github.com/siteboon/claudecodeui/commit/3ec76b5bb15a13cec41056f4c9b9c425195022fa))

### Maintenance

* update Claude fallback models ([94785bf](https://github.com/siteboon/claudecodeui/commit/94785bfa579d1f39a2bee0f9dd0f09fd0243bc79))
* update package-lock.json ([c90b341](https://github.com/siteboon/claudecodeui/commit/c90b34108e86a3effdb5c6979ea7b1692d2b9da0))

## [](https://github.com/siteboon/claudecodeui/compare/v1.32.0...vnull) (2026-06-01)

### New Features

* add opencode support ([#762](https://github.com/siteboon/claudecodeui/issues/762)) ([374e9de](https://github.com/siteboon/claudecodeui/commit/374e9de71934c41ce2c19c796e35a19234b240ec))
* **sidebar:** tooltip for the active-session indicator dot ([#782](https://github.com/siteboon/claudecodeui/issues/782)) ([27e509a](https://github.com/siteboon/claudecodeui/commit/27e509a9b8bb25c35ae0abbda44c536e15c332c8))

### Bug Fixes

* **chat:** prevent double send on mobile by removing redundant submit handlers ([#719](https://github.com/siteboon/claudecodeui/issues/719)) ([dbc41dc](https://github.com/siteboon/claudecodeui/commit/dbc41dc91dbf1fb54f92f5536d64646b4e924f31))
* preserve WebSocket frame type in plugin proxy ([#594](https://github.com/siteboon/claudecodeui/issues/594)) ([36b860e](https://github.com/siteboon/claudecodeui/commit/36b860e322454df62ebf5309018590b596e6b913)), closes [CoderLuii/HolyClaude#11](https://github.com/CoderLuii/HolyClaude/issues/11)
* refine token usage reporting ([#807](https://github.com/siteboon/claudecodeui/issues/807)) ([38bf21d](https://github.com/siteboon/claudecodeui/commit/38bf21ddf554ed28676d86b5221c25adf6f07afd))
* refresh Claude auth status after login flow ([#617](https://github.com/siteboon/claudecodeui/issues/617)) ([1e125f3](https://github.com/siteboon/claudecodeui/commit/1e125f3db5248399cd50dc3d40b1f8f44cf7ccb6))
* **sidebar:** keep session rename input visible while editing ([#781](https://github.com/siteboon/claudecodeui/issues/781)) ([951f587](https://github.com/siteboon/claudecodeui/commit/951f58751c152fbbb3f8b3ce3c814c06c061de18))

### Styling

* fix project star button location by replacing folder icon ([#793](https://github.com/siteboon/claudecodeui/issues/793)) ([295bad9](https://github.com/siteboon/claudecodeui/commit/295bad9c006b669878cbf52940794f29f7370178))

## [1.32.0](https://github.com/siteboon/claudecodeui/compare/v1.31.5...v1.32.0) (2026-05-13)

### Bug Fixes

* add clarification on auto mode ([392c73b](https://github.com/siteboon/claudecodeui/commit/392c73b6933600ea8a589c5d4eff5f7b830f99c5))
* enhance regex to correctly parse wrapper file paths for claude.exe ([#741](https://github.com/siteboon/claudecodeui/issues/741)) ([beb0a50](https://github.com/siteboon/claudecodeui/commit/beb0a50413beddfb16f6b49103e1b6b80567cb90))

## [1.31.5](https://github.com/siteboon/claudecodeui/compare/v1.31.4...v1.31.5) (2026-04-30)

### New Features

* add auto mode to claude code ([3f71d49](https://github.com/siteboon/claudecodeui/commit/3f71d4932b05dfedcdf816e2a3d7d0cd69c4f566))

## [1.31.4](https://github.com/siteboon/claudecodeui/compare/v1.31.3...v1.31.4) (2026-04-30)

### Bug Fixes

* bump codex sdk to latest version ([658421c](https://github.com/siteboon/claudecodeui/commit/658421c1c44ec4eb58b69ec7b1844a9fba11a3f3))

## [1.31.3](https://github.com/siteboon/claudecodeui/compare/v1.31.2...v1.31.3) (2026-04-30)

## [1.31.2](https://github.com/siteboon/claudecodeui/compare/v1.31.0...v1.31.2) (2026-04-30)

### Bug Fixes

* migrations for new sqlite schema ([0753c04](https://github.com/siteboon/claudecodeui/commit/0753c047837dab17b86ae4453027e30b465870f8))

## [1.31.0](https://github.com/siteboon/claudecodeui/compare/v1.30.0...v1.31.0) (2026-04-30)

### Bug Fixes

* **/status:** use CLAUDE_MODELS.DEFAULT instead of stale 'claude-sonnet-4.5' fallback ([#723](https://github.com/siteboon/claudecodeui/issues/723)) ([b4a39c7](https://github.com/siteboon/claudecodeui/commit/b4a39c729710a6294c62eb742e99e05f3e3914e9))

## [1.30.0](https://github.com/siteboon/claudecodeui/compare/v1.29.5...v1.30.0) (2026-04-21)

### New Features

* **i18n:** add Italian language support ([#677](https://github.com/siteboon/claudecodeui/issues/677)) ([86b6545](https://github.com/siteboon/claudecodeui/commit/86b6545c3505475ac2de0cec75cc8f86ab22aceb))
* **i18n:** add Turkish (tr) language support ([#678](https://github.com/siteboon/claudecodeui/issues/678)) ([89b754d](https://github.com/siteboon/claudecodeui/commit/89b754d186b68f3df8aa439a2d535644406066f0)), closes [#384](https://github.com/siteboon/claudecodeui/issues/384) [#514](https://github.com/siteboon/claudecodeui/issues/514) [#525](https://github.com/siteboon/claudecodeui/issues/525) [#534](https://github.com/siteboon/claudecodeui/issues/534)
* introduce opus 4.7 ([#682](https://github.com/siteboon/claudecodeui/issues/682)) ([c5e55ad](https://github.com/siteboon/claudecodeui/commit/c5e55adc89d0316675f90a927aa40d115958ae9f))

### Bug Fixes

* iOS scrolling main chat area ([3969135](https://github.com/siteboon/claudecodeui/commit/3969135bd427fbf48f29bb3dbfedb47791ca78dc))
* migrate PlanDisplay raw params from native details to Collapsible primitive ([fc3504e](https://github.com/siteboon/claudecodeui/commit/fc3504eaed8ca7ed9214838d148ea385b8352c31))
* precise Claude SDK denial message detection in deriveToolStatus ([09dcea0](https://github.com/siteboon/claudecodeui/commit/09dcea05fbc8c208d931aa1f08618f0e8087392f))
* reduce size of permission mode button tap target and provider selector on  mobile ([457ca0d](https://github.com/siteboon/claudecodeui/commit/457ca0daabcaa8397f4375ee8aa2671336b648ff))
* small mobile respnosive fixes ([25820ed](https://github.com/siteboon/claudecodeui/commit/25820ed995c1b813b1f9ed073097b08eb1d902ec))
* small mobile respnosive fixes ([c471b5d](https://github.com/siteboon/claudecodeui/commit/c471b5d3fa6ce1968adb4cf87a15ac0e18febd20))

### Refactoring

* add primitives, plan mode display, and new session model selector ([7763e60](https://github.com/siteboon/claudecodeui/commit/7763e60fb32e34742058c055c57664a503a34d1d))
* chat composer new design ([5758bee](https://github.com/siteboon/claudecodeui/commit/5758bee8a038ed50073dba882108617959dda82c))
* queue primitive, tool status badges, and tool display cleanup ([ec0ff97](https://github.com/siteboon/claudecodeui/commit/ec0ff974cba213a1100b2a071b8ba533e812fe82))

### Maintenance

* add docker sandbox action ([fa5a238](https://github.com/siteboon/claudecodeui/commit/fa5a23897c086bcacf1cf5d926c650f98a0f2222))

## [1.29.5](https://github.com/siteboon/claudecodeui/compare/v1.29.4...v1.29.5) (2026-04-16)

### Bug Fixes

* update node-pty to latest version ([6a13e17](https://github.com/siteboon/claudecodeui/commit/6a13e1773b145049ade512aa6e5cac21c2e5c4de))

## [1.29.4](https://github.com/siteboon/claudecodeui/compare/v1.29.3...v1.29.4) (2026-04-16)

### New Features

* deleting from sidebar will now ask whether to remove all data as well ([e9c7a50](https://github.com/siteboon/claudecodeui/commit/e9c7a5041c31a6f7b2032f06abe19c52d3d4cd8c))

### Bug Fixes

* pass pathToClaudeCodeExecutable to SDK when CLAUDE_CLI_PATH is set ([4c106a5](https://github.com/siteboon/claudecodeui/commit/4c106a5083d90989bbeedaefdbb68f5b3fa6fd58)), closes [#468](https://github.com/siteboon/claudecodeui/issues/468)

### Refactoring

* remove the sqlite3 dependency ([2895208](https://github.com/siteboon/claudecodeui/commit/289520814cf3ca36403056739ef22021f78c6033))
* **server:** extract URL detection and color utils from index.js ([#657](https://github.com/siteboon/claudecodeui/issues/657)) ([63e996b](https://github.com/siteboon/claudecodeui/commit/63e996bb77cfa97b1f55f6bdccc50161a75a3eee))

### Maintenance

* upgrade commit lint to 20.5.0 ([0948601](https://github.com/siteboon/claudecodeui/commit/09486016e67d97358c228ebc6eb4502ccb0012e4))

## [1.29.3](https://github.com/siteboon/claudecodeui/compare/v1.29.2...v1.29.3) (2026-04-15)

### Bug Fixes

* **version-upgrade-modal:** implement reload countdown and update UI messages ([#655](https://github.com/siteboon/claudecodeui/issues/655)) ([6413042](https://github.com/siteboon/claudecodeui/commit/641304242d7705b54aab65faa4a7673438c92c60))

### Maintenance

* remove unused route (migrated to providers already) ([31f28a2](https://github.com/siteboon/claudecodeui/commit/31f28a2c183f6ead50941027632d7ab64b7bb2d4))

## [1.29.2](https://github.com/siteboon/claudecodeui/compare/v1.29.1...v1.29.2) (2026-04-14)

### Bug Fixes

* **sandbox:** use backgrounded sbx run to keep sandbox  alive ([9b11c03](https://github.com/siteboon/claudecodeui/commit/9b11c034d9a19710a23b56c62dcf07c21a17bd97))

## [1.29.1](https://github.com/siteboon/claudecodeui/compare/v1.29.0...v1.29.1) (2026-04-14)

### Bug Fixes

* add latest tag to docker npx command and change the detach mode to work without spawn ([4a56972](https://github.com/siteboon/claudecodeui/commit/4a569725dae320a505753359d8edfd8ca79f0fd7))

## [1.29.0](https://github.com/siteboon/claudecodeui/compare/v1.28.1...v1.29.0) (2026-04-14)

### New Features

* adding docker sandbox environments ([13e97e2](https://github.com/siteboon/claudecodeui/commit/13e97e2c71254de7a60afb5495b21064c4bc4241))

### Bug Fixes

* **thinking-mode:** fix dropdown positioning ([#646](https://github.com/siteboon/claudecodeui/issues/646)) ([c7a5baf](https://github.com/siteboon/claudecodeui/commit/c7a5baf1479404bd40e23aa58bd9f677df9a04c6))

### Maintenance

* update release flow node version ([e2459cb](https://github.com/siteboon/claudecodeui/commit/e2459cb0f8b35f54827778a7b444e6c3ca326506))

## [1.28.1](https://github.com/siteboon/claudecodeui/compare/v1.28.0...v1.28.1) (2026-04-10)

### New Features

* add branding, community links, GitHub star badge, and About settings tab ([2207d05](https://github.com/siteboon/claudecodeui/commit/2207d05c1ca229214aa9c2e2c9f4d0827d421574))

### Bug Fixes

* corrupted binary downloads ([#634](https://github.com/siteboon/claudecodeui/issues/634)) ([e61f8a5](https://github.com/siteboon/claudecodeui/commit/e61f8a543d63fe7c24a04b3d2186085a06dcbcdb))
* **ui:** remove mobile bottom nav, unify processing indicator, and improve tooltip behavior on mobile ([#632](https://github.com/siteboon/claudecodeui/issues/632)) ([a8dab0e](https://github.com/siteboon/claudecodeui/commit/a8dab0edcf949ae610820bae9500c433781f7c73))

### Refactoring

* remove unused whispher transcribe logic ([#637](https://github.com/siteboon/claudecodeui/issues/637)) ([590dd42](https://github.com/siteboon/claudecodeui/commit/590dd42649424ab990353fcf59ce0965036d3d25))

## [1.28.0](https://github.com/siteboon/claudecodeui/compare/v1.27.1...v1.28.0) (2026-04-03)

### New Features

* adding session resume in the api ([8f1042c](https://github.com/siteboon/claudecodeui/commit/8f1042cf256be282f009adcceeb55ab2dddf3fba))
* moving new session button higher ([1628868](https://github.com/siteboon/claudecodeui/commit/16288684702dec894cf054291ca3d545ddb8214b))

### Maintenance

* changing package name to @cloudcli-ai/cloudcli ([ef51de2](https://github.com/siteboon/claudecodeui/commit/ef51de259ea2b963bc15f058b084e11220bc216a))

## [1.27.1](https://github.com/siteboon/claudecodeui/compare/v1.26.3...v1.27.1) (2026-03-29)

### Bug Fixes

* prevent split on undefined（[#491](https://github.com/siteboon/claudecodeui/issues/491)） ([#563](https://github.com/siteboon/claudecodeui/issues/563)) ([b54cdf8](https://github.com/siteboon/claudecodeui/commit/b54cdf8168fc224e9907796e4229ae8ed34e6885))

### Maintenance

* add release-it github action ([42a1313](https://github.com/siteboon/claudecodeui/commit/42a131389a6954df0d2c3bedd2cb6d3406c5ebc1))
* add terminal plugin in the plugins list ([004135e](https://github.com/siteboon/claudecodeui/commit/004135ef0187023e1da29c4a7137a28a42ebf9af))
* release tokens ([f1063fd](https://github.com/siteboon/claudecodeui/commit/f1063fd33964ccb517f5ebcdd14526ed162e1138))
* relicense to AGPL-3.0-or-later ([27cd124](https://github.com/siteboon/claudecodeui/commit/27cd12432b7d3237981f86acd9cc99532d843d4a))

## [1.26.3](https://github.com/siteboon/claudecodeui/compare/v1.26.2...v1.26.3) (2026-03-22)

## [1.26.2](https://github.com/siteboon/claudecodeui/compare/v1.26.0...v1.26.2) (2026-03-21)

### Bug Fixes

* change SW cache mechanism ([17d6ec5](https://github.com/siteboon/claudecodeui/commit/17d6ec54af18d333c8b04d2ffc64793e688d996e))
* claude auth changes and adding copy on mobile ([a41d2c7](https://github.com/siteboon/claudecodeui/commit/a41d2c713e87d56f23d5884585b4bb43c43a250a))

## [1.26.0](https://github.com/siteboon/claudecodeui/compare/v1.25.2...v1.26.0) (2026-03-20)

### New Features

* add German (Deutsch) language support ([#525](https://github.com/siteboon/claudecodeui/issues/525)) ([a7299c6](https://github.com/siteboon/claudecodeui/commit/a7299c68237908c752d504c2e8eea91570a30203))
* add WebSocket proxy for plugin backends ([#553](https://github.com/siteboon/claudecodeui/issues/553)) ([88c60b7](https://github.com/siteboon/claudecodeui/commit/88c60b70b031798d51ce26c8f080a0f64d824b05))
* Browser autofill support for login form ([#521](https://github.com/siteboon/claudecodeui/issues/521)) ([72ff134](https://github.com/siteboon/claudecodeui/commit/72ff134b315b7a1d602f3cc7dd60d47c1c1c34af))
* git panel redesign ([#535](https://github.com/siteboon/claudecodeui/issues/535)) ([adb3a06](https://github.com/siteboon/claudecodeui/commit/adb3a06d7e66a6d2dbcdfb501615e617178314af))
* introduce notification system and claude notifications ([#450](https://github.com/siteboon/claudecodeui/issues/450)) ([45e71a0](https://github.com/siteboon/claudecodeui/commit/45e71a0e73b368309544165e4dcf8b7fd014e8dd))
* **refactor:** move plugins to typescript ([#557](https://github.com/siteboon/claudecodeui/issues/557)) ([612390d](https://github.com/siteboon/claudecodeui/commit/612390db536417e2f68c501329bfccf5c6795e45))
* unified message architecture with provider adapters and session store ([#558](https://github.com/siteboon/claudecodeui/issues/558)) ([a4632dc](https://github.com/siteboon/claudecodeui/commit/a4632dc4cec228a8febb7c5bae4807c358963678))

### Bug Fixes

* detect Claude auth from settings env ([#527](https://github.com/siteboon/claudecodeui/issues/527)) ([95bcee0](https://github.com/siteboon/claudecodeui/commit/95bcee0ec459f186d52aeffe100ac1a024e92909))
* remove /exit command from claude login flow during onboarding ([#552](https://github.com/siteboon/claudecodeui/issues/552)) ([4de8b78](https://github.com/siteboon/claudecodeui/commit/4de8b78c6db5d8c2c402afce0f0b4cc16d5b6496))

### Documentation

* add German language link to all README files ([#534](https://github.com/siteboon/claudecodeui/issues/534)) ([1d31c3e](https://github.com/siteboon/claudecodeui/commit/1d31c3ec8309b433a041f3099955addc8c136c35))
* **readme:** hotfix and improve for README.jp.md ([#550](https://github.com/siteboon/claudecodeui/issues/550)) ([7413c2c](https://github.com/siteboon/claudecodeui/commit/7413c2c78422c308ac949e6a83c3e9216b24b649))
* **README:** update translations with CloudCLI branding and feature restructuring ([#544](https://github.com/siteboon/claudecodeui/issues/544)) ([14aef73](https://github.com/siteboon/claudecodeui/commit/14aef73cc6085fbb519fe64aea7cac80b7d51285))

## [1.25.2](https://github.com/siteboon/claudecodeui/compare/v1.25.0...v1.25.2) (2026-03-11)

### New Features

* **i18n:** localize plugin settings for all languages ([#515](https://github.com/siteboon/claudecodeui/issues/515)) ([621853c](https://github.com/siteboon/claudecodeui/commit/621853cbfb4233b34cb8cc2e1ed10917ba424352))

### Bug Fixes

* codeql user value provided path validation ([aaa14b9](https://github.com/siteboon/claudecodeui/commit/aaa14b9fc0b9b51c4fb9d1dba40fada7cbbe0356))
* numerous bugs ([#528](https://github.com/siteboon/claudecodeui/issues/528)) ([a77f213](https://github.com/siteboon/claudecodeui/commit/a77f213dd5d0b2538dea091ab8da6e55d2002f2f))
* **security:** disable executable gray-matter frontmatter in commands ([b9c902b](https://github.com/siteboon/claudecodeui/commit/b9c902b016f411a942c8707dd07d32b60bad087c))
* session reconnect catch-up, always-on input, frozen session recovery ([#524](https://github.com/siteboon/claudecodeui/issues/524)) ([4d8fb6e](https://github.com/siteboon/claudecodeui/commit/4d8fb6e30aa03d7cdb92bd62b7709422f9d08e32))

### Refactoring

* new settings page design and new pill component ([8ddeeb0](https://github.com/siteboon/claudecodeui/commit/8ddeeb0ce8d0642560bd3fa149236011dc6e3707))

## [1.25.0](https://github.com/siteboon/claudecodeui/compare/v1.24.0...v1.25.0) (2026-03-10)

### New Features

* add copy as text or markdown feature for assistant messages ([#519](https://github.com/siteboon/claudecodeui/issues/519)) ([1dc2a20](https://github.com/siteboon/claudecodeui/commit/1dc2a205dc2a3cbf960625d7669c7c63a2b6905f))
* add full Russian language support; update Readme.md files, and .gitignore update ([#514](https://github.com/siteboon/claudecodeui/issues/514)) ([c7dcba8](https://github.com/siteboon/claudecodeui/commit/c7dcba8d9117e84db8aac7d8a7bf6a3aa683e115))
* new plugin system ([#489](https://github.com/siteboon/claudecodeui/issues/489)) ([8afb46a](https://github.com/siteboon/claudecodeui/commit/8afb46af2e5514c9284030367281793fbb014e4f))

### Bug Fixes

* resolve duplicate key issue when rendering model options ([#520](https://github.com/siteboon/claudecodeui/issues/520)) ([9bceab9](https://github.com/siteboon/claudecodeui/commit/9bceab9e1a6e063b0b4f934ed2d9f854fcc9c6a4))

### Maintenance

* add plugins section in readme ([e581a0e](https://github.com/siteboon/claudecodeui/commit/e581a0e1ccd59fd7ec7306ca76a13e73d7c674c1))

## [1.24.0](https://github.com/siteboon/claudecodeui/compare/v1.23.2...v1.24.0) (2026-03-09)

### New Features

* add full-text search across conversations ([#482](https://github.com/siteboon/claudecodeui/issues/482)) ([3950c0e](https://github.com/siteboon/claudecodeui/commit/3950c0e47f41e93227af31494690818d45c8bc7a))

### Bug Fixes

* **git:** prevent shell injection in git routes ([86c33c1](https://github.com/siteboon/claudecodeui/commit/86c33c1c0cb34176725a38f46960213714fc3e04))
* replace getDatabase with better-sqlite3 db in getGithubTokenById ([#501](https://github.com/siteboon/claudecodeui/issues/501)) ([cb4fd79](https://github.com/siteboon/claudecodeui/commit/cb4fd795c938b1cc86d47f401973bfccdd68fdee))

## [1.23.2](https://github.com/siteboon/claudecodeui/compare/v1.22.1...v1.23.2) (2026-03-06)

### New Features

* add clickable overlay buttons for CLI prompts in Shell terminal ([#480](https://github.com/siteboon/claudecodeui/issues/480)) ([2444209](https://github.com/siteboon/claudecodeui/commit/2444209723701dda2b881cea2501b239e64e51c1)), closes [#427](https://github.com/siteboon/claudecodeui/issues/427)
* add terminal shortcuts panel for mobile ([#411](https://github.com/siteboon/claudecodeui/issues/411)) ([b0a3fdf](https://github.com/siteboon/claudecodeui/commit/b0a3fdf95ffdb961261194d10400267251e42f17))
* implement session rename with SQLite storage ([#413](https://github.com/siteboon/claudecodeui/issues/413)) ([198e3da](https://github.com/siteboon/claudecodeui/commit/198e3da89b353780f53a91888384da9118995e81)), closes [#72](https://github.com/siteboon/claudecodeui/issues/72) [#358](https://github.com/siteboon/claudecodeui/issues/358)

### Bug Fixes

* **chat:** finalize terminal lifecycle to prevent stuck processing/thinking UI ([#483](https://github.com/siteboon/claudecodeui/issues/483)) ([0590c5c](https://github.com/siteboon/claudecodeui/commit/0590c5c178f4791e2b039d525ecca4d220c3dcae))
* **codex-history:** prevent AGENTS.md/internal prompt leakage when reloading Codex sessions ([#488](https://github.com/siteboon/claudecodeui/issues/488)) ([64a96b2](https://github.com/siteboon/claudecodeui/commit/64a96b24f853acb802f700810b302f0f5cf00898))
* preserve pending permission requests across WebSocket reconnections ([#462](https://github.com/siteboon/claudecodeui/issues/462)) ([4ee88f0](https://github.com/siteboon/claudecodeui/commit/4ee88f0eb0c648b54b05f006c6796fb7b09b0fae))
* prevent React 18 batching from losing messages during session sync ([#461](https://github.com/siteboon/claudecodeui/issues/461)) ([688d734](https://github.com/siteboon/claudecodeui/commit/688d73477a50773e43c85addc96212aa6290aea5))
* release it script ([dcea8a3](https://github.com/siteboon/claudecodeui/commit/dcea8a329c7d68437e1e72c8c766cf33c74637e9))

### Styling

* improve UI for processing banner ([#477](https://github.com/siteboon/claudecodeui/issues/477)) ([2320e1d](https://github.com/siteboon/claudecodeui/commit/2320e1d74b59c65b5b7fc4fa8b05fd9208f4898c))

### Maintenance

* remove logging of received WebSocket messages in production ([#487](https://github.com/siteboon/claudecodeui/issues/487)) ([9193feb](https://github.com/siteboon/claudecodeui/commit/9193feb6dc83041f3c365204648a88468bdc001b))

## [1.22.0](https://github.com/siteboon/claudecodeui/compare/v1.21.0...v1.22.0) (2026-03-03)

### New Features

* add community button in the app ([84d4634](https://github.com/siteboon/claudecodeui/commit/84d4634735f9ee13ac1c20faa0e7e31f1b77cae8))
* Advanced file editor and file tree improvements ([#444](https://github.com/siteboon/claudecodeui/issues/444)) ([9768958](https://github.com/siteboon/claudecodeui/commit/97689588aa2e8240ba4373da5f42ab444c772e72))
* update document title based on selected project ([#448](https://github.com/siteboon/claudecodeui/issues/448)) ([9e22f42](https://github.com/siteboon/claudecodeui/commit/9e22f42a3d3a781f448ddac9d133292fe103bb8c))

### Bug Fixes

* **claude:** correct project encoded path ([#451](https://github.com/siteboon/claudecodeui/issues/451)) ([9c0e864](https://github.com/siteboon/claudecodeui/commit/9c0e864532dcc5ce7ee890d3b4db722872db2b54)), closes [#447](https://github.com/siteboon/claudecodeui/issues/447)
* **claude:** move model usage log to result message only ([#454](https://github.com/siteboon/claudecodeui/issues/454)) ([506d431](https://github.com/siteboon/claudecodeui/commit/506d43144b3ec3155c3e589e7e803862c4a8f83a))
* missing translation label ([855e22f](https://github.com/siteboon/claudecodeui/commit/855e22f9176a71daa51de716370af7f19d55bfb4))

### Maintenance

* add Gemini-CLI support to README ([#453](https://github.com/siteboon/claudecodeui/issues/453)) ([503c384](https://github.com/siteboon/claudecodeui/commit/503c3846850fb843781979b0c0e10a24b07e1a4b))

## [1.21.0](https://github.com/siteboon/claudecodeui/compare/v1.20.1...v1.21.0) (2026-02-27)

### New Features

* add copy icon for user messages ([#449](https://github.com/siteboon/claudecodeui/issues/449)) ([b359c51](https://github.com/siteboon/claudecodeui/commit/b359c515277b4266fde2fb9a29b5356949c07c4f))
* Google's gemini-cli integration ([#422](https://github.com/siteboon/claudecodeui/issues/422)) ([a367edd](https://github.com/siteboon/claudecodeui/commit/a367edd51578608b3281373cb4a95169dbf17f89))
* persist active tab across reloads via localStorage ([#414](https://github.com/siteboon/claudecodeui/issues/414)) ([e3b6892](https://github.com/siteboon/claudecodeui/commit/e3b689214f11d549ffe1b3a347476d58f25c5aca)), closes [#387](https://github.com/siteboon/claudecodeui/issues/387)

### Bug Fixes

* add support for Codex in the shell ([#424](https://github.com/siteboon/claudecodeui/issues/424)) ([23801e9](https://github.com/siteboon/claudecodeui/commit/23801e9cc15d2b8d1bfc6e39aee2fae93226d1ad))

### Maintenance

* upgrade @anthropic-ai/claude-agent-sdk to version 0.2.59 and add model usage logging ([#446](https://github.com/siteboon/claudecodeui/issues/446)) ([917c353](https://github.com/siteboon/claudecodeui/commit/917c353115653ee288bf97be01f62fad24123cbc))
* upgrade better-sqlite to latest version to support node 25 ([#445](https://github.com/siteboon/claudecodeui/issues/445)) ([4ab94fc](https://github.com/siteboon/claudecodeui/commit/4ab94fce4257e1e20370fa83fa4c0f6fadbb8a2b))

## [1.20.1](https://github.com/siteboon/claudecodeui/compare/v1.19.1...v1.20.1) (2026-02-23)

### New Features

* implement install mode detection and update commands in version upgrade process ([f986004](https://github.com/siteboon/claudecodeui/commit/f986004319207b068431f9f6adf338a8ce8decfc))
* migrate legacy database to new location and improve last login update handling ([50e097d](https://github.com/siteboon/claudecodeui/commit/50e097d4ac498aa9f1803ef3564843721833dc19))

## [1.19.1](https://github.com/siteboon/claudecodeui/compare/v1.19.0...v1.19.1) (2026-02-23)

### Bug Fixes

* add prepublishOnly script to build before publishing ([82efac4](https://github.com/siteboon/claudecodeui/commit/82efac4704cab11ed8d1a05fe84f41312140b223))

## [1.19.0](https://github.com/siteboon/claudecodeui/compare/v1.18.2...v1.19.0) (2026-02-23)

### New Features

* add HOST environment variable for configurable bind address ([#360](https://github.com/siteboon/claudecodeui/issues/360)) ([cccd915](https://github.com/siteboon/claudecodeui/commit/cccd915c336192216b6e6f68e2b5f3ece0ccf966))
* subagent tool grouping ([#398](https://github.com/siteboon/claudecodeui/issues/398)) ([0207a1f](https://github.com/siteboon/claudecodeui/commit/0207a1f3a3c87f1c6c1aee8213be999b23289386))

### Bug Fixes

* **macos:** fix node-pty posix_spawnp error with postinstall script ([#347](https://github.com/siteboon/claudecodeui/issues/347)) ([38a593c](https://github.com/siteboon/claudecodeui/commit/38a593c97fdb2bb7f051e09e8e99c16035448655)), closes [#284](https://github.com/siteboon/claudecodeui/issues/284)
* slash commands with arguments bypass command execution ([#392](https://github.com/siteboon/claudecodeui/issues/392)) ([597e9c5](https://github.com/siteboon/claudecodeui/commit/597e9c54b76e7c6cd1947299c668c78d24019cab))

### Refactoring

* **releases:** Create a contributing guide and proper release notes using a release-it plugin ([fc369d0](https://github.com/siteboon/claudecodeui/commit/fc369d047e13cba9443fe36c0b6bb2ce3beaf61c))

### Maintenance

* update @anthropic-ai/claude-agent-sdk to version 0.1.77 in package-lock.json ([#410](https://github.com/siteboon/claudecodeui/issues/410)) ([7ccbc8d](https://github.com/siteboon/claudecodeui/commit/7ccbc8d92d440e18c157b656c9ea2635044a64f6))
