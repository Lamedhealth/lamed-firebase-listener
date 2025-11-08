const admin = require("firebase-admin");
const fetch = require("node-fetch");
const { getDatabase } = require("firebase-admin/database");
const http = require("http");

// ----------------------------
// 1️⃣ Firebase Admin Init
// ----------------------------
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT env variable not set!");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL:
    "https://lamedtelemedicine-default-rtdb.europe-west1.firebasedatabase.app/",
});

const db = getDatabase();
const WORKER_URL = "https://lamed-notifierr.medatesfe21.workers.dev";

// ----------------------------
// 2️⃣ Send Notification Helper
// ----------------------------
const sendNotificationViaWorker = async (playerId, title, message) => {
  if (!playerId) return;
  try {
    const res = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerId, title, body: message }),
    });
    const data = await res.json();
    console.log(`✅ Notification sent to ${playerId}`, data);
  } catch (err) {
    console.error("❌ Notification error:", err);
  }
};

// ----------------------------
// 3️⃣ Get Player ID
// ----------------------------
const getPlayerId = async (userId) => {
  if (!userId) return null;
  try {
    const snap = await db.ref(`/users/${userId}/oneSignalPlayerId`).once("value");
    return snap.val();
  } catch (e) {
    console.error(`❌ Error fetching Player ID for ${userId}`, e);
    return null;
  }
};

// ----------------------------
// 4️⃣ Notify User
// ----------------------------
const notifyUser = async (userId, title, message) => {
  const playerId = await getPlayerId(userId);
  if (!playerId) return;
  await sendNotificationViaWorker(playerId, title, message);
};

// ----------------------------
// 5️⃣ Child Added Listener (ignore old data)
// ----------------------------
const createChildAddedListener = (ref, callback) => {
  let loaded = false;
  ref.once("value").then(() => (loaded = true));
  ref.on("child_added", async (snapshot) => {
    if (!loaded) return; // ignore old data
    const data = snapshot.val();
    if (!data) return;
    await callback(data, snapshot.key);
  });
};

// ----------------------------
// Appointments
// ----------------------------
createChildAddedListener(db.ref("/appointments"), async (appointment) => {
  const patientName = appointment.patientName || "Patient";
  const doctorName = appointment.doctorName || "Doctor";

  if (appointment.doctorId)
    await notifyUser(
      appointment.doctorId,
      "🩺 New Appointment Booked",
      `${patientName} booked a session with you.`
    );

  if (appointment.patientId)
    await notifyUser(
      appointment.patientId,
      "📅 Appointment Scheduled",
      `Your appointment with Dr. ${doctorName} is scheduled.`
    );
});

// ----------------------------
// Prescriptions & Lab Requests (per user)
// ----------------------------
const setupUserFilesListener = (type) => {
  db.ref("/patient_files").on("child_added", (userSnap) => {
    const userId = userSnap.key;
    const ref = db.ref(`/patient_files/${userId}/${type}`);
    createChildAddedListener(ref, async (item) => {
      if (!item) return;
      const title = type === "prescriptions" ? "💊 New Prescription" : "🧪 New Lab Result";
      const doctorName = item.Doctor || "Doctor";
      await notifyUser(userId, title, `Dr. ${doctorName} uploaded a new ${type.slice(0, -1)} for you.`);
    });
  });
};

setupUserFilesListener("prescriptions");
setupUserFilesListener("lab_requests");

// ----------------------------
// Chat Messages
// ----------------------------
db.ref("/chats").on("child_added", (chatSnap) => {
  const chatId = chatSnap.key;
  const messagesRef = db.ref(`/chats/${chatId}/messages`);

  createChildAddedListener(messagesRef, async (msg) => {
    if (!msg || !msg.to) return; // <- matches Flutter 'to' field
    if (msg.from === msg.to) return; // don't notify self

    let text = msg.text || "";
    if (msg.fileUrl) text = "📎 Sent you a new file";

    await notifyUser(msg.to, "💬 New Message", text);
  });
});

// ----------------------------
// Payment Updates
// ----------------------------
let paymentsLoaded = false;
db.ref("/payments").once("value").then(() => (paymentsLoaded = true));

db.ref("/payments").on("child_changed", async (snap) => {
  if (!paymentsLoaded) return;
  const payment = snap.val();
  if (!payment || !payment.patientId) return;
  await notifyUser(payment.patientId, "💰 Payment Update", `Your payment status is now ${payment.status || "updated"}.`);
});

// ----------------------------
// Minimal HTTP Server
// ----------------------------
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Firebase listener is running.\n");
  })
  .listen(PORT, () => console.log(`🌐 Web service listening on port ${PORT}`));

console.log("👂 Listening to Firebase Realtime Database...");
