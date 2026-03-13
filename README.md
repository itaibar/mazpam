# 🎫 מזפמ - מערכת כרטיסיות

מערכת ניהול כרטיסיות מודרנית (Ticketing System) עבור ניהול מקומות.
בנוי עם **React** + **Material UI** עם עיצוב responsive מלא בעברית.

## ✨ תכונות

- ✅ **יצירת כרטיסים** - טופס אינטואיטיבי עם Material UI
- ✅ **תצוגת כרטיסים** - כרטיסים כ-cards responsive
- ✅ **ניהול Admin** - עריכה מלאה, SLA tracking, הערות פנימיות
- ✅ **SLA Tracking** - עקיבה אוטומטית בהתאם לעדיפות
- ✅ **עברית מלאה** - RTL, עיצוב responsive
- ✅ **11 מכללות/מחלקות** - תא דיווח, תא מפקד, וכו'

## 🚀 התקנה והרצה

```bash
cd /Users/itbar/src/mazpam

# התקנה (יכול לקחת דקה או שתיים)
npm install

# בטרמינל 1 - הרץ את ה-Backend API
npm run server

# בטרמינל 2 - הרץ את ה-Frontend dev server
npm run dev
```

פתח את הדפדפן: **http://localhost:5173**

## 📁 מבנה הפרויקט

```
mazpam/
├── server.mjs                    # Node.js API backend
├── index.html                    # HTML entry point
├── vite.config.js               # Vite configuration
├── package.json                 # Dependencies
└── src/
    ├── main.jsx                 # React entry point
    ├── App.jsx                  # Main component
    └── components/
        ├── CreateTicketForm.jsx # יצירת כרטיסים
        ├── ViewTickets.jsx       # צפייה בכרטיסים
        ├── TicketCard.jsx        # Card component
        └── AdminPanel.jsx        # ניהול כרטיסים
```

## 🔧 API Endpoints

- `GET /api/config` - קטגוריות, עדיפויות, סטטוסים, מכללות
- `GET /api/tickets` - כל הכרטיסים
- `POST /api/tickets` - כרטיס חדש
- `GET /api/tickets/:id` - כרטיס ספציפי
- `PATCH /api/tickets/:id` - עדכן כרטיס
- `DELETE /api/tickets/:id` - מחק כרטיס

## 📊 קטגוריות ומכללות

### קטגוריות
- ברוגוז (Bug)
- בקשה חדשה (Feature)
- שאלה (Question)
- תלונה (Complaint)

### מכללות (11 אפשרויות)
- תא דיווח
- תא מפקד
- תא פקודות
- תא תכנון
- תקשוב
- שולחן מרכזי
- רפואה
- מלכ״א
- מודיעין
- הלפדסק
- אוכלוסיה

### סטטוסים
- פתוח (Open)
- בעבודה (In Progress)
- בהמתנה (On Hold)
- סגור (Closed)

### עדיפויות ו-SLA
- **נמוכה** - 72 שעות
- **בינונית** - 48 שעות
- **גבוהה** - 24 שעות
- **קריטית** - 4 שעות

## 🎨 טכנולוגיות

- **Frontend**: React 18 + Material UI 5
- **Backend**: Node.js HTTP server
- **Build**: Vite
- **Styling**: Material UI + Emotion
- **HTTP**: Axios

## 📝 ערות

- נתונים ב-memory (לייצור: הוסף MongoDB/PostgreSQL)
- Responsive בכל גדלי מסכנים
- RTL (עברית) מובנה
- Dark mode ready

