import { auth, db } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, addDoc, updateDoc,
  collection, query, where, orderBy, onSnapshot,
  writeBatch, increment, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ============================================================
// حالة التطبيق العامة
// ============================================================
let selectedRole = null;      // "seller" | "customer" — قبل تسجيل الدخول
let currentUser = null;
let currentUserPhone = null;  // الرقم بصيغة موحّدة (أرقام فقط، بلا مسافات أو +)
let currentShopId = null;
let currentShopName = null;
let currentTxType = "debt";
let selectedLinkId = null;    // العلاقة (زبون-بائع) المفتوحة حالياً
let lastAddedLinkId = null;
let unsubscribeList = null;   // لإلغاء الاستماع اللحظي عند تغيير الشاشة
let unsubscribeTx = null;

// ============================================================
// التنقل بين الشاشات
// ============================================================
window.showScreen = function (id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
};

window.chooseRole = function (role) {
  selectedRole = role;
  showScreen("screen-phone");
};

window.logout = async function () {
  if (unsubscribeList) unsubscribeList();
  if (unsubscribeTx) unsubscribeTx();
  await signOut(auth);
  currentUser = null;
  currentUserPhone = null;
  currentShopId = null;
  showScreen("screen-welcome");
};

// ============================================================
// المصادقة برقم الهاتف + رمز سري (PIN)
// نستخدم Firebase Email/Password Auth من الخلف، عبر تحويل رقم
// الهاتف إلى "بريد اصطناعي" (مثال: 22241234567@daftar.local).
// هذا لا يحتاج أي فوترة أو بطاقة بنكية، بعكس إرسال SMS حقيقي.
// ============================================================

// يحوّل أي صيغة لرقم الهاتف إلى أرقام فقط، ليكون معرّفاً موحّداً
function normalizePhone(phone) {
  return phone.replace(/[^0-9]/g, "");
}

function syntheticEmail(normalizedPhone) {
  return `${normalizedPhone}@daftar.local`;
}

window.registerNew = async function () {
  const phoneRaw = document.getElementById("phone-input").value.trim();
  const pin = document.getElementById("pin-input").value.trim();
  const errorEl = document.getElementById("phone-error");
  errorEl.textContent = "";

  const phone = normalizePhone(phoneRaw);
  if (phone.length < 8) {
    errorEl.textContent = "أدخل رقم هاتف صحيح";
    return;
  }
  if (pin.length < 6) {
    errorEl.textContent = "الرمز السري يجب أن يكون 6 أرقام على الأقل";
    return;
  }

  try {
    const result = await createUserWithEmailAndPassword(auth, syntheticEmail(phone), pin);
    currentUser = result.user;
    currentUserPhone = phone;
    await setDoc(doc(db, "users", currentUser.uid), {
      phone,
      createdAt: serverTimestamp(),
    });
    await afterLogin();
  } catch (err) {
    if (err.code === "auth/email-already-in-use") {
      errorEl.textContent = "يوجد حساب مسجَّل بهذا الرقم بالفعل، اضغط تسجيل الدخول بدلاً من ذلك";
    } else {
      errorEl.textContent = "حدث خطأ، حاول مجدداً";
    }
    console.error(err);
  }
};

window.loginExisting = async function () {
  const phoneRaw = document.getElementById("phone-input").value.trim();
  const pin = document.getElementById("pin-input").value.trim();
  const errorEl = document.getElementById("phone-error");
  errorEl.textContent = "";

  const phone = normalizePhone(phoneRaw);
  if (phone.length < 8 || !pin) {
    errorEl.textContent = "أدخل رقم الهاتف والرمز السري";
    return;
  }

  try {
    const result = await signInWithEmailAndPassword(auth, syntheticEmail(phone), pin);
    currentUser = result.user;
    currentUserPhone = phone;
    await afterLogin();
  } catch (err) {
    if (err.code === "auth/invalid-credential" || err.code === "auth/wrong-password") {
      errorEl.textContent = "الرمز السري غير صحيح";
    } else if (err.code === "auth/user-not-found") {
      errorEl.textContent = "لا يوجد حساب بهذا الرقم، اضغط \"إنشاء حساب جديد\"";
    } else {
      errorEl.textContent = "حدث خطأ، حاول مجدداً";
    }
    console.error(err);
  }
};

// بعد نجاح تسجيل الدخول، وجّه المستخدم حسب دوره
async function afterLogin() {
  if (selectedRole === "seller") {
    const shopQuery = query(collection(db, "shops"), where("ownerId", "==", currentUser.uid));
    const snap = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js")
      .then((m) => m.getDocs(shopQuery));

    if (snap.empty) {
      showScreen("screen-shop-setup");
    } else {
      const shopDoc = snap.docs[0];
      currentShopId = shopDoc.id;
      currentShopName = shopDoc.data().shopName;
      document.getElementById("shop-name-display").textContent = currentShopName;
      showScreen("screen-seller-dashboard");
      listenSellerDashboard();
    }
  } else {
    showScreen("screen-customer-dashboard");
    listenCustomerDashboard();
  }
}

// إعادة تسجيل الدخول التلقائي لو كانت الجلسة محفوظة بالفعل
onAuthStateChanged(auth, async (user) => {
  if (user && !currentUser && selectedRole) {
    currentUser = user;
    const userDoc = await getDoc(doc(db, "users", user.uid));
    currentUserPhone = userDoc.exists() ? userDoc.data().phone : null;
    afterLogin();
  }
});

// ============================================================
// إعداد المحل (أول مرة للبائع)
// ============================================================
window.createShop = async function () {
  const shopName = document.getElementById("shop-name-input").value.trim();
  const ownerName = document.getElementById("owner-name-input").value.trim();
  const errorEl = document.getElementById("shop-setup-error");
  errorEl.textContent = "";

  if (!shopName || !ownerName) {
    errorEl.textContent = "أدخل اسم المحل واسمك";
    return;
  }

  try {
    const shopRef = await addDoc(collection(db, "shops"), {
      ownerId: currentUser.uid,
      ownerName,
      shopName,
      createdAt: serverTimestamp(),
    });
    currentShopId = shopRef.id;
    currentShopName = shopName;
    document.getElementById("shop-name-display").textContent = shopName;
    showScreen("screen-seller-dashboard");
    listenSellerDashboard();
  } catch (err) {
    errorEl.textContent = "حدث خطأ، حاول مجدداً";
    console.error(err);
  }
};

// ============================================================
// لوحة البائع: قائمة الزبائن (مرتبة حسب الأحدث نشاطاً)
// ============================================================
function listenSellerDashboard() {
  if (unsubscribeList) unsubscribeList();
  const q = query(
    collection(db, "shopCustomers"),
    where("shopId", "==", currentShopId),
    orderBy("lastActivityAt", "desc")
  );
  unsubscribeList = onSnapshot(q, (snap) => {
    const list = document.getElementById("customers-list");
    list.innerHTML = "";
    snap.forEach((docSnap) => {
      const c = docSnap.data();
      const row = document.createElement("div");
      row.className = "cust-row";
      row.onclick = () => openCustomerDetail(docSnap.id, c);
      const pendingBadge = !c.isLinked ? `<span class="badge badge-pending">بانتظار الربط</span>` : "";
      row.innerHTML = `
        <div>
          <p class="cust-row-name">${c.customerNameAtShop}</p>
          <p class="cust-row-meta">${pendingBadge}${timeAgo(c.lastActivityAt)}</p>
        </div>
        <span class="badge ${c.currentBalance > 0 ? "badge-debt" : "badge-credit"}">
          ${c.currentBalance > 0 ? riyal(c.currentBalance) : "مسدَّد"}
        </span>`;
      list.appendChild(row);
    });
  });
}

// ============================================================
// إضافة زبون جديد
// ============================================================
window.addCustomer = async function () {
  const name = document.getElementById("new-cust-name").value.trim();
  const phone = document.getElementById("new-cust-phone").value.trim();
  const errorEl = document.getElementById("add-cust-error");
  errorEl.textContent = "";

  if (!name || !phone) {
    errorEl.textContent = "أدخل الاسم ورقم الهاتف";
    return;
  }

  const normalizedPhone = normalizePhone(phone);
  const linkCode = String(Math.floor(1000 + Math.random() * 9000));

  try {
    const ref = await addDoc(collection(db, "shopCustomers"), {
      shopId: currentShopId,
      shopName: currentShopName,
      customerNameAtShop: name,
      customerPhone: normalizedPhone,
      customerId: null,
      isLinked: false,
      linkCode,
      currentBalance: 0,
      createdAt: serverTimestamp(),
      lastActivityAt: serverTimestamp(),
    });
    lastAddedLinkId = ref.id;
    document.getElementById("new-cust-name").value = "";
    document.getElementById("new-cust-phone").value = "";
    document.getElementById("code-for-name").textContent = `شارك هذا الكود مع ${name}`;
    document.getElementById("generated-code").textContent = linkCode;
    showScreen("screen-show-code");
  } catch (err) {
    errorEl.textContent = "حدث خطأ، حاول مجدداً";
    console.error(err);
  }
};

window.copyCode = function () {
  const code = document.getElementById("generated-code").textContent;
  navigator.clipboard.writeText(code);
};

window.openCustomerFromCode = async function () {
  const snap = await getDoc(doc(db, "shopCustomers", lastAddedLinkId));
  openCustomerDetail(lastAddedLinkId, snap.data());
};

// ============================================================
// تفاصيل زبون عند البائع + تسجيل معاملة
// ============================================================
function openCustomerDetail(linkId, data) {
  selectedLinkId = linkId;
  document.getElementById("cust-detail-name").textContent = data.customerNameAtShop;
  setTxType("debt");
  showScreen("screen-customer-detail");

  if (unsubscribeTx) unsubscribeTx();
  const linkRef = doc(db, "shopCustomers", linkId);
  unsubscribeTx = onSnapshot(linkRef, (snap) => {
    const c = snap.data();
    const balEl = document.getElementById("cust-detail-balance");
    balEl.textContent = riyal(c.currentBalance);
    balEl.className = "balance-amount " + (c.currentBalance > 0 ? "debt" : "credit");
  });

  const txQuery = query(collection(db, "shopCustomers", linkId, "transactions"), orderBy("createdAt", "desc"));
  onSnapshot(txQuery, (snap) => renderTransactions(snap, "cust-transactions-list"));
}

window.setTxType = function (type) {
  currentTxType = type;
  document.getElementById("toggle-debt").className = "toggle-opt" + (type === "debt" ? " active-debt" : "");
  document.getElementById("toggle-payment").className = "toggle-opt" + (type === "payment" ? " active-credit" : "");
};

window.saveTransaction = async function () {
  const product = document.getElementById("tx-product").value.trim();
  const amount = Number(document.getElementById("tx-amount").value);
  const errorEl = document.getElementById("tx-error");
  errorEl.textContent = "";

  if (!product || !amount || amount <= 0) {
    errorEl.textContent = "أدخل اسم المنتج ومبلغاً صحيحاً";
    return;
  }

  try {
    const batch = writeBatch(db);
    const txRef = doc(collection(db, "shopCustomers", selectedLinkId, "transactions"));
    batch.set(txRef, {
      type: currentTxType,
      product,
      amount,
      originalAmount: amount,
      editHistory: [],
      createdAt: serverTimestamp(),
    });
    const delta = currentTxType === "debt" ? amount : -amount;
    batch.update(doc(db, "shopCustomers", selectedLinkId), {
      currentBalance: increment(delta),
      lastActivityAt: serverTimestamp(),
    });
    await batch.commit();
    document.getElementById("tx-product").value = "";
    document.getElementById("tx-amount").value = "";
  } catch (err) {
    errorEl.textContent = "حدث خطأ، حاول مجدداً";
    console.error(err);
  }
};

// ============================================================
// الزبون: ربط بائع جديد عبر الكود
// ============================================================
window.linkShop = async function () {
  const code = document.getElementById("link-code-input").value.trim();
  const errorEl = document.getElementById("link-code-error");
  errorEl.textContent = "";

  try {
    const q = query(collection(db, "shopCustomers"), where("linkCode", "==", code), where("isLinked", "==", false));
    const snap = await (await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js")).getDocs(q);

    if (snap.empty) {
      errorEl.textContent = "كود غير صحيح أو مستخدم مسبقاً";
      return;
    }

    const linkDoc = snap.docs[0];
    const data = linkDoc.data();
    if (data.customerPhone !== currentUserPhone) {
      errorEl.textContent = "هذا الكود ليس مخصصاً لرقم هاتفك";
      return;
    }

    await updateDoc(doc(db, "shopCustomers", linkDoc.id), {
      isLinked: true,
      customerId: currentUser.uid,
      linkedAt: serverTimestamp(),
    });

    document.getElementById("link-code-input").value = "";
    showScreen("screen-customer-dashboard");
  } catch (err) {
    errorEl.textContent = "حدث خطأ، حاول مجدداً";
    console.error(err);
  }
};

// ============================================================
// لوحة الزبون: قائمة البائعين المرتبطين
// ============================================================
function listenCustomerDashboard() {
  if (unsubscribeList) unsubscribeList();
  const q = query(
    collection(db, "shopCustomers"),
    where("customerId", "==", currentUser.uid),
    orderBy("lastActivityAt", "desc")
  );
  unsubscribeList = onSnapshot(q, (snap) => {
    const list = document.getElementById("shops-list");
    list.innerHTML = "";
    snap.forEach((docSnap) => {
      const c = docSnap.data();
      const row = document.createElement("div");
      row.className = "cust-row";
      row.onclick = () => openShopDetail(docSnap.id, c);
      row.innerHTML = `
        <div>
          <p class="cust-row-name">${c.shopName}</p>
          <p class="cust-row-meta">${timeAgo(c.lastActivityAt)}</p>
        </div>
        <span class="badge ${c.currentBalance > 0 ? "badge-debt" : "badge-credit"}">
          ${c.currentBalance > 0 ? riyal(c.currentBalance) : "مسدَّد"}
        </span>`;
      list.appendChild(row);
    });
  });
}

function openShopDetail(linkId, data) {
  document.getElementById("shop-detail-name").textContent = data.shopName;
  showScreen("screen-shop-detail");

  if (unsubscribeTx) unsubscribeTx();
  const linkRef = doc(db, "shopCustomers", linkId);
  unsubscribeTx = onSnapshot(linkRef, (snap) => {
    const c = snap.data();
    const balEl = document.getElementById("shop-detail-balance");
    balEl.textContent = riyal(c.currentBalance);
    balEl.className = "balance-amount " + (c.currentBalance > 0 ? "debt" : "credit");
  });

  const txQuery = query(collection(db, "shopCustomers", linkId, "transactions"), orderBy("createdAt", "desc"));
  onSnapshot(txQuery, (snap) => renderTransactions(snap, "shop-transactions-list"));
}

// ============================================================
// أدوات مساعدة
// ============================================================
function renderTransactions(snap, containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (snap.empty) {
    container.innerHTML = `<p class="cust-row-meta">لا معاملات بعد</p>`;
    return;
  }
  snap.forEach((docSnap) => {
    const t = docSnap.data();
    const item = document.createElement("div");
    item.className = "tx-item";
    let editHtml = "";
    (t.editHistory || []).forEach((e) => {
      editHtml += `<p class="tx-edit">✎ عُدّل من ${riyal(e.from)} إلى ${riyal(e.to)}</p>`;
    });
    item.innerHTML = `
      <div class="tx-row">
        <span>${t.product}</span>
        <span class="tx-amount ${t.type === "debt" ? "debt" : "credit"}">
          ${t.type === "debt" ? "+" : "-"}${riyal(t.amount)}
        </span>
      </div>
      <p class="tx-date">${timeAgo(t.createdAt)}</p>
      ${editHtml}`;
    container.appendChild(item);
  });
}

function riyal(n) {
  return `${Number(n).toLocaleString("ar")} أوقية`;
}

function timeAgo(timestamp) {
  if (!timestamp) return "الآن";
  const seconds = Math.floor((Date.now() - timestamp.toDate().getTime()) / 1000);
  if (seconds < 60) return "الآن";
  if (seconds < 3600) return `منذ ${Math.floor(seconds / 60)} دقيقة`;
  if (seconds < 86400) return `منذ ${Math.floor(seconds / 3600)} ساعة`;
  return `منذ ${Math.floor(seconds / 86400)} يوم`;
}