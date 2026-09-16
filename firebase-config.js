// ============================================================
// إعدادات مشروع "دفتر" على Firebase
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAeIlSfm9ikr-MdETwbygs6BOBG4sLaYGw",
  authDomain: "daftar-fb786.firebaseapp.com",
  projectId: "daftar-fb786",
  storageBucket: "daftar-fb786.firebasestorage.app",
  messagingSenderId: "1021793114354",
  appId: "1:1021793114354:web:f585f2aa6a90f81c80586b",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
