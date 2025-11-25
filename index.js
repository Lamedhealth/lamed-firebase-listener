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
// 2️⃣ Global Error Handlers
// ----------------------------
process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));
process.on("unhandledRejection", (reason, promise) =>
  console.error("Unhandled Rejection at:", promise, "reason:", reason)
);

// ----------------------------
// 3️⃣ Send Notification Helper
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
// 4️⃣ Get Player ID
// ----------------------------
const getPlayerId = async (userId) => {
  if (!userId) return null;
  try {
    const snap = await db.ref(`/users/${userId}/oneSignalPlayerId`).once("value"); // ensure key matches Flutter

    return snap.val();
  } catch (e) {
    console.error(`❌ Error fetching Player ID for ${userId}`, e);
    return null;
  }
};

// ----------------------------
// 5️⃣ Notify User
// ----------------------------
const notifyUser = async (userId, title, message) => {
  try {
    const playerId = await getPlayerId(userId);
    if (!playerId) return;
    await sendNotificationViaWorker(playerId, title, message);
  } catch (err) {
    console.error("❌ notifyUser error:", err);
  }
};

// ----------------------------
// 6️⃣ Child Added Listener (ignore old data)
// ----------------------------
const createChildAddedListener = (ref, callback) => {
  let loaded = false;
  ref.once("value").then(() => (loaded = true));
  ref.on("child_added", async (snapshot) => {
    if (!loaded) return;
    const data = snapshot.val();
    if (!data) return;
    try {
      await callback(data, snapshot.key);
    } catch (err) {
      console.error("❌ child_added listener error:", err);
    }
  });
};

// ----------------------------
// 7️⃣ Appointment Reminder Scheduler
// ----------------------------
const checkUpcomingAppointments = async () => {
  try {
    const now = Date.now();
    const twentyMinutes = 20 * 60 * 1000;
    const tenMinutes = 10 * 60 * 1000;

    const snapshot = await db.ref("/appointments").once("value");
    snapshot.forEach(async (child) => {
      try {
        const appointment = child.val();
        if (!appointment || !appointment.timestamp) return;

        const appointmentTime = new Date(appointment.timestamp).getTime();
        const timeUntil = appointmentTime - now;

        // 20-min reminder
        if (timeUntil > 0 && timeUntil <= twentyMinutes && !appointment.reminder20Sent) {
          console.log("⏰ Sending 20-min reminder for:", child.key);
          if (appointment.patientId)
            await notifyUser(
              appointment.patientId,
              "⏰ መዘከሪ ቆፀሮ",
              "ቆፀርኦም ኣብ ውሽጢ 20 ደቒቓ ክጅምር እዩ። ተዳለው!"
            );
          if (appointment.doctorId) {
            const patientName = appointment.patientName || "your patient";
            await notifyUser(
              appointment.doctorId,
              "🩺 Upcoming Appointment",
              `Your appointment with ${patientName} starts in 20 minutes.`
            );
          }
          await db.ref(`/appointments/${child.key}`).update({ reminder20Sent: true });
        }

        // 10-min reminder
        if (timeUntil > 0 && timeUntil <= tenMinutes && !appointment.reminder10Sent) {
          console.log("⏰ Sending 10-min reminder for:", child.key);
          if (appointment.patientId)
            await notifyUser(
              appointment.patientId,
              "⏰ መዘከሪ ቆፀሮ",
              "ቆፀርኦም ኣብ ውሽጢ 10 ደቒቓ ክጅምር እዩ። ይእተዉ!"
            );
          if (appointment.doctorId) {
            const patientName = appointment.patientName || "your patient";
            await notifyUser(
              appointment.doctorId,
              "🩺 Upcoming Appointment",
              `Your appointment with ${patientName} starts in 10 minutes. Please get ready.`
            );
          }
          await db.ref(`/appointments/${child.key}`).update({ reminder10Sent: true });
        }
      } catch (err) {
        console.error("❌ Error processing appointment:", err);
      }
    });
  } catch (err) {
    console.error("❌ checkUpcomingAppointments error:", err);
  }
};

setInterval(checkUpcomingAppointments, 60 * 1000);

// ----------------------------
// 8️⃣ Appointments Listener
// ----------------------------
createChildAddedListener(db.ref("/appointments"), async (appointment) => {
  try {
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
        "📅 ሓድሽ ቆፀሮ ሒዞም ኣለዉ",
        `ቆፀሮ ምስ Dr. ${doctorName} ሒዞም ኣለዉ።`
      );
  } catch (err) {
    console.error("❌ Appointments listener error:", err);
  }
});

// ----------------------------
// 9️⃣ Prescriptions & Lab Requests
// ----------------------------
const setupUserFilesListener = (type) => {
  db.ref("/patient_files").on("child_added", (userSnap) => {
    const userId = userSnap.key;
    const ref = db.ref(`/patient_files/${userId}/${type}`);
    createChildAddedListener(ref, async (item) => {
      if (!item) return;
      try {
        const title =
          type === "prescriptions"
            ? "💊 ሓድሽ መድሓኒት ተኣዚዝሎም ኣሎ።"
            : "🧪 ሓድሽ ምርመራ ተኣዚዝሎም ኣሎ።";
        const doctorName = item.Doctor || "Doctor";
        await notifyUser(
          userId,
          title,
          `Dr. ${doctorName} uploaded a new ${type.slice(0, -1)} for you.`
        );
      } catch (err) {
        console.error(`❌ Error notifying ${type} for user ${userId}:`, err);
      }
    });
  });
};

setupUserFilesListener("prescriptions");
setupUserFilesListener("lab_requests");

// ----------------------------
// 🔟 Chat Messages
// ----------------------------
db.ref("/chats").on("child_added", (chatSnap) => {
  const chatId = chatSnap.key;
  const messagesRef = db.ref(`/chats/${chatId}/messages`);
  createChildAddedListener(messagesRef, async (msg) => {
    if (!msg || !msg.to || msg.from === msg.to) return;
    try {
      let text = msg.text || "";
      if (msg.fileUrl) text = "📎 ሓድሽ ፋይል ተላኢኽሎም ኣሎ ";
      await notifyUser(msg.to, "💬 ሓድሽ መልእኽቲ", text);
    } catch (err) {
      console.error("❌ Chat message notification error:", err);
    }
  });
});

// ----------------------------
// 1️⃣1️⃣ Payment Updates
// ----------------------------
let appointmentsLoaded = false;
db.ref("/appointments").once("value").then(() => (appointmentsLoaded = true));

const handlePayment = async (appointment) => {
  if (!appointment || !appointment.patientId) return;
  try {
    const status = (appointment.paymentStatus || appointment.status || "").toLowerCase();
    if (status === "paid" || status === "confirmed") {
      await notifyUser(
        appointment.patientId,
        "💰 ክፍሊቶም ተቀቢልናዮ ኣለና።",
        "💰 የቐንየልና! ክፍሊቶም ተቀቢልናዮ ኣለና።"
      );
    } else if (["rejected", "failed", "declined"].includes(status)) {
      await notifyUser(
        appointment.patientId,
        "⚠️ ክፍሊቶም ኣይተቀበልናዮን።",
        "ንዝህልዎም ቅሬታ በይዘኦም ይደውሉልና 0986203585 / 0914017765"
      );
    }
  } catch (err) {
    console.error("❌ Payment notification error:", err);
  }
};

db.ref("/appointments").on("child_changed", async (snap) => {
  if (!appointmentsLoaded) return;
  try {
    const appointment = snap.val();
    console.log("💰 Appointment changed:", appointment);
    await handlePayment(appointment);
  } catch (err) {
    console.error("❌ child_changed listener error:", err);
  }
});

// ----------------------------
// 🔹 Minimal HTTP Server (keep alive on Render)
// ----------------------------
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  if (req.url === "/ping") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Pong! Service is alive.\n");
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Firebase listener is running.\n");
  }
}).listen(PORT, () => console.log(`🌐 Web service listening on port ${PORT}`));

console.log("👂 Listening to Firebase Realtime Database...");
