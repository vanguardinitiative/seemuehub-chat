import express, { type Application } from "express";
import http from "http";
import dotenv from "dotenv";
import cors from "cors";
import connectDB from "./config/database";
import { setupSocketService } from "./config/socket";
import router from "./routes";
import { scheduleDailyCancellation } from "./services/cron";
// import { scheduleEveryMinuteCancellation } from "@/services/cron";
dotenv.config();
connectDB();
const app: Application = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use("/v1/api", router);
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

const port = process.env.PORT || 8181;
// const port = 8181;

console.log("Server is starting...");

const server = http.createServer(app);
// Initialize Socket.IO service
setupSocketService(server);

// Schedule daily cron at 02:00 local time
scheduleDailyCancellation(2, 0);
// scheduleEveryMinuteCancellation(1);

server.listen(port, () => {
  console.log(`Socket service running on port ${port}`);
});
