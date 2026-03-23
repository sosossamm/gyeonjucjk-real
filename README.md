# 견적비교 — Vercel 배포 가이드

## 폴더 구조
```
gyeokjeok/
├── api/
│   └── analyze.js      ← 서버리스 API 프록시 (API 키 보관)
├── public/
│   └── index.html      ← 프론트엔드
└── vercel.json         ← Vercel 설정
```

---

## 배포 순서 (5분)

### 1단계 — Vercel 가입
https://vercel.com 에서 GitHub 계정으로 가입

### 2단계 — GitHub에 올리기
```bash
# 이 폴더를 GitHub 저장소로 만들기
git init
git add .
git commit -m "first commit"
git remote add origin https://github.com/내아이디/gyeokjeok.git
git push -u origin main
```

### 3단계 — Vercel에서 import
1. vercel.com/dashboard → "Add New Project"
2. GitHub 저장소 선택
3. **Environment Variables** 에서 아래 추가:
   - Key: `ANTHROPIC_API_KEY`
   - Value: `sk-ant-...` (Anthropic Console에서 발급)
4. Deploy 클릭

### 4단계 — 완료
`https://내프로젝트명.vercel.app` 으로 접속 가능

---

## API 키 발급
https://console.anthropic.com/keys 에서 발급
(첫 가입 시 $5 크레딧 무료 제공)

## 비용 참고
- Claude Sonnet 기준 견적서 1건 분석 ≈ $0.003 (약 4원)
- Vercel 호스팅: 무료 플랜으로 충분
