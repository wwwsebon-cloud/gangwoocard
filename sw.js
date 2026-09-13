/* ##########################################################################
   [Ver 14.11] 서비스 워커 — PC 앱으로 설치해 쓰기 위한 장치
   --------------------------------------------------------------------------
   ▶ 하는 일은 둘뿐이다.
       ① 오프라인에서도 게임이 켜지게 한다
       ② 앱으로 설치할 수 있게 한다 (브라우저가 fetch 처리기를 요구한다)

   ▶ 캐시 전략 — 파일 성격이 완전히 달라 **두 갈래**로 나눈다.
       · index.html (게임 본체, 8MB)  → 캐시를 **먼저 주고**, 뒤에서 새것을 확인한다.
         8MB를 매번 내려받으면 켜는 데만 한참 걸린다. 그래서 캐시를 즉시 주고,
         배경에서 ETag 로 갱신 여부만 확인한 뒤 바뀌었으면 화면에 알린다.
         ⚠ fetch 는 기본 캐시 모드라 브라우저가 If-None-Match 를 자동으로 붙인다.
           안 바뀌었으면 304 라 실제 전송량은 0에 가깝다.
       · 그림·소리 (art·audio·chip·chip2·pfp·pw·icons) → 캐시에 있으면 그걸 쓴다.
         한 번 올라간 파일은 내용이 바뀌지 않는다(바뀌면 이름이 바뀐다).

   ⚠ ★ 설치할 때 전부 미리 받지 않는다. ★
     에셋이 50MB 라 미리 받기로 잡으면 설치가 몇 분씩 걸리고, 하나라도 실패하면
     **설치 전체가 실패한다.** 그래서 껍데기만 받아두고 나머지는 쓸 때 담는다.

   ⚠ ★ 바깥 주소는 아예 건드리지 않는다. ★
     Firestore·구글 폰트·CDN 이 전부 여기를 지나간다. 캐시했다가는
     "밴을 걸었는데 안 먹는다", "전적이 옛날 것으로 보인다" 같은 일이 난다.
     POST 같은 것도 마찬가지다 — GET 이 아니면 손대지 않는다.

   ⚠ 캐시 이름에 버전을 박아 둔다. 올리면 옛 캐시가 통째로 버려진다.
     그림·소리는 다시 받아야 하지만, 껍데기가 꼬였을 때 확실히 푸는 유일한 수단이다.
   ########################################################################## */
const SW_VERSION  = 'v15.9';
const SHELL_CACHE = 'gg-shell-' + SW_VERSION;   // 게임 본체
const ASSET_CACHE = 'gg-asset-' + SW_VERSION;   // 그림·소리

/* 쓸 때 담는 폴더들. 여기 없는 경로는 그냥 네트워크로 보낸다. */
const ASSET_DIRS = ['art/', 'audio/', 'chip/', 'chip2/', 'pfp/', 'pw/', 'icons/'];

/* 설치 — 껍데기만. 실패해도 설치는 성공시킨다(오프라인에서 설치될 수도 있다). */
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    try {
      const c = await caches.open(SHELL_CACHE);
      await c.addAll(['./', './index.html', './manifest.json']);
    } catch (err) { /* 나중에 켤 때 담긴다 */ }
    self.skipWaiting();
  })());
});

/* 활성화 — 옛 버전 캐시를 버린다. */
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      if (k.startsWith('gg-') && k !== SHELL_CACHE && k !== ASSET_CACHE) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

function isAsset(url) {
  return ASSET_DIRS.some(d => url.pathname.includes('/' + d) || url.pathname.startsWith(d));
}
function isShell(url, req) {
  if (req.mode === 'navigate') return true;
  return url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
}

/* 새 버전이 올라왔다고 열려 있는 화면들에 알린다. */
async function tellClients(msg) {
  const list = await self.clients.matchAll({ type: 'window' });
  list.forEach(c => { try { c.postMessage(msg); } catch (e) {} });
}

/* 이 응답이 "아까 그것과 같은 파일인가"를 가리는 지문.
   ⚠ 처음에는 ETag 하나만 봤다가 **로컬 서버에서 감지가 통째로 죽었다.**
     ETag 를 안 보내는 서버가 흔한데, 그러면 둘 다 null 이라 "같다"로 새어 나가
     업데이트 알림이 영영 안 뜬다. 셋 중 있는 것을 순서대로 쓴다.
   ⚠ 그래도 아무것도 없으면 null 을 돌려주고, 부르는 쪽이 **알리지 않는다.**
     헛알림(안 바뀌었는데 새로고침하라고 조르기)이 못 알리는 것보다 나쁘다. */
function resSig(res) {
  if (!res) return null;
  const h = res.headers;
  return h.get('etag') || h.get('last-modified') || h.get('content-length') || null;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  /* ⚠ GET 이 아니거나 남의 주소면 손대지 않는다 — Firestore 가 여기로 지나간다. */
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  /* ---- 게임 본체 — 캐시를 먼저 주고, 뒤에서 새것을 확인한다 ---- */
  if (isShell(url, req)) {
    e.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match('./index.html');

      const refresh = (async () => {
        try {
          const fresh = await fetch(req);            // 브라우저가 ETag 로 알아서 확인한다
          if (!fresh || !fresh.ok) return null;
          const oldSig = resSig(cached);
          const newSig = resSig(fresh);
          await cache.put('./index.html', fresh.clone());
          /* 옛것이 있었고 지문이 달라졌다면 = 업데이트가 올라왔다.
             ⚠ 지문을 하나도 못 구하면 알리지 않는다 — 헛알림이 더 나쁘다. */
          if (cached && oldSig && newSig && oldSig !== newSig) {
            tellClients({ type: 'GG_UPDATE_READY', version: SW_VERSION });
          }
          return fresh;
        } catch (err) { return null; }
      })();

      if (cached) { e.waitUntil(refresh); return cached; }   // 즉시 켜진다
      const fresh = await refresh;
      return fresh || new Response('오프라인이고 저장된 게임도 없습니다.', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    })());
    return;
  }

  /* ---- 그림·소리 — 있으면 캐시, 없으면 받아서 담는다 ---- */
  if (isAsset(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(ASSET_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        /* ⚠ 실패한 응답(404 등)은 담지 않는다. 담으면 그 파일이 영영 깨진 채로 굳는다. */
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (err) {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }
  /* 나머지는 브라우저에 맡긴다 */
});

/* 화면이 "지금 바로 새 버전으로 갈아타라"고 시키면 따른다. */
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'GG_SKIP_WAITING') self.skipWaiting();
});
