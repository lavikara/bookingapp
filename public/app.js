const connectForm = document.querySelector("#connect-form");
const apiKeyInput = document.querySelector("#api-key");
const refreshButton = document.querySelector("#refresh-button");
const slotsElement = document.querySelector("#slots");
const noticeElement = document.querySelector("#notice");
const bookingPanel = document.querySelector("#booking-panel");
const bookingForm = document.querySelector("#booking-form");
const selectedSlotElement = document.querySelector("#selected-slot");
const confirmationElement = document.querySelector("#confirmation");
const lookupForm = document.querySelector("#lookup-form");
const lookupResult = document.querySelector("#lookup-result");

let apiKey = localStorage.getItem("clinic-api-key") || "";
let selectedSlot = null;
apiKeyInput.value = apiKey;

function showNotice(message = "") {
  noticeElement.textContent = message;
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function formatTime(date) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(date));
}

async function loadSlots() {
  if (!apiKey) {
    showNotice("Enter the API key to connect.");
    return;
  }
  showNotice("");
  refreshButton.disabled = true;
  try {
    const data = await apiRequest("/slots");
    slotsElement.replaceChildren();
    const availableSlots = data.slots.filter((slot) => slot.available);
    if (!availableSlots.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "There are no available appointments right now. Please check again soon.";
      slotsElement.append(empty);
      return;
    }
    for (const slot of availableSlots) {
      const card = document.createElement("article");
      card.className = "slot-card";
      const provider = document.createElement("p");
      provider.className = "provider";
      provider.textContent = slot.provider;
      const title = document.createElement("h3");
      title.textContent = formatTime(slot.start);
      const time = document.createElement("p");
      time.className = "time";
      time.textContent = `${formatTime(slot.start)} – ${new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(slot.end))}`;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Choose this time";
      button.addEventListener("click", () => selectSlot(slot));
      card.append(provider, title, time, button);
      slotsElement.append(card);
    }
  } catch (error) {
    showNotice(error.message);
  } finally {
    refreshButton.disabled = false;
  }
}

function selectSlot(slot) {
  selectedSlot = slot;
  selectedSlotElement.textContent = `${slot.provider} · ${formatTime(slot.start)}`;
  bookingPanel.hidden = false;
  confirmationElement.hidden = true;
  bookingPanel.scrollIntoView({ behavior: "smooth", block: "center" });
  document.querySelector("#patient-name").focus();
}

connectForm.addEventListener("submit", (event) => {
  event.preventDefault();
  apiKey = apiKeyInput.value.trim();
  localStorage.setItem("clinic-api-key", apiKey);
  loadSlots();
});
refreshButton.addEventListener("click", loadSlots);
document.querySelector("#close-booking").addEventListener("click", () => {
  bookingPanel.hidden = true;
});

bookingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedSlot) return;
  const button = document.querySelector("#submit-booking");
  button.disabled = true;
  showNotice("");
  const formData = new FormData(bookingForm);
  try {
    const booking = await apiRequest("/bookings", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        slot_id: selectedSlot.id,
        name: formData.get("name"),
        email: formData.get("email"),
      }),
    });
    bookingPanel.hidden = true;
    confirmationElement.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent = "Appointment confirmed";
    const summary = document.createElement("p");
    summary.textContent = `${selectedSlot.provider} · ${formatTime(selectedSlot.start)}`;
    const id = document.createElement("p");
    id.className = "booking-id";
    id.textContent = `Booking ID: ${booking.id}`;
    const explanation = document.createElement("p");
    explanation.textContent = "Save this ID to look up or cancel your appointment.";
    confirmationElement.append(heading, summary, id, explanation);
    confirmationElement.hidden = false;
    document.querySelector("#booking-id").value = booking.id;
    await loadSlots();
  } catch (error) {
    showNotice(error.message);
  } finally {
    button.disabled = false;
  }
});

async function showBooking(booking, container) {
  container.replaceChildren();
  const card = document.createElement("div");
  card.className = "lookup-booking";
  const state = document.createElement("p");
  state.textContent = `Status: ${booking.status}`;
  const patient = document.createElement("p");
  patient.textContent = `${booking.name} · ${booking.email}`;
  const id = document.createElement("p");
  id.textContent = `Booking ID: ${booking.id}`;
  card.append(state, patient, id);
  if (booking.status === "confirmed") {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "button-secondary";
    cancel.textContent = "Cancel booking";
    cancel.addEventListener("click", async () => {
      cancel.disabled = true;
      try {
        const cancelled = await apiRequest(`/bookings/${encodeURIComponent(booking.id)}`, {
          method: "DELETE",
        });
        await showBooking(cancelled, container);
        await loadSlots();
      } catch (error) {
        showNotice(error.message);
        cancel.disabled = false;
      }
    });
    card.append(cancel);
  }
  container.append(card);
}

lookupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showNotice("");
  const id = document.querySelector("#booking-id").value.trim();
  try {
    const booking = await apiRequest(`/bookings/${encodeURIComponent(id)}`);
    await showBooking(booking, lookupResult);
  } catch (error) {
    lookupResult.replaceChildren();
    showNotice(error.message);
  }
});

if (apiKey) loadSlots();
