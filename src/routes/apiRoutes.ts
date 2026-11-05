import { Router } from "express";
import { createBooking } from "../controllers/createBookingController";
import {
  cancelBooking,
  getBooking,
  listBookings,
} from "../controllers/bookingsController";
import { resetSlots } from "../controllers/resetController";
import { listSlots } from "../controllers/slotsController";

const router = Router();

router.post("/reset", resetSlots);
router.get("/slots", listSlots);
router.post("/bookings", createBooking);
router.get("/bookings", listBookings);
router.get("/bookings/:id", getBooking);
router.delete("/bookings/:id", cancelBooking);

export default router;
