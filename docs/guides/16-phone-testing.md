# 16. Test the kiosk on your phone

One page, step by step. You need: the dashboard open on a laptop
(`https://samtec-test.vercel.app`, an ADMIN account), a phone with a camera
and a fingerprint sensor, and one real person per worker you enrol. The
kiosk's address is `https://samtec-test-kiosk.vercel.app`; open it in Chrome
or Safari and allow the camera when the phone asks.

Some dashboard steps are **sensitive actions**: the first one asks for your
own password in a small "Confirm with your password" box. Type it once; you
will not be asked again for five minutes.

## The three steps for every device

Every device goes through the same three steps, and each screen says which
one comes next: **1. Register** (dashboard), **2. Set up the kiosk** (phone),
**3. Switch it on** (dashboard).

1. **Register the device.** Dashboard → **Devices** → **Register device**.
   Name it (for example "Samuel's phone"), choose the site the worker is
   posted to, keep the kind **Face kiosk**, and tick **Allow fingerprints on
   this kiosk's own sensor**. Press **Register device**. The page shows the
   **Device ID** and the **secret** once, each with a **Copy** button. Copy both
   somewhere safe for a minute; the secret is never shown again.
2. **Set up the phone.** Open the kiosk address on the phone. The set-up form
   asks for the Device ID, the secret and a name. Paste them in and press the
   button. The phone now shows the clock-in screen with the device name at the
   top left and a small **Admin** button at the top right.
3. **Switch it on.** Back on the dashboard, open the device's page and press
   **Switch on**. Until you do, the phone's requests are refused.

## Enrol a worker, save a fingerprint, clock in

4. **Enrol a worker's face.** On the phone press **Admin**, sign in with your
   dashboard email, password and six-digit code, then choose **Enroll a
   worker's face**. Pick the worker (only workers who are *Pending enrollment*
   and posted to this kiosk's site are listed), type the last four digits of
   their Ghana Card, read them the consent words and tick that they agree.
   The phone takes three pictures while the worker looks at the camera and
   turns their head when asked. One real person per worker: never enrol two
   workers with the same face.
5. **Save their fingerprint.** Straight after a face that passed, press
   **Save their fingerprint on this phone** and let the worker touch the
   phone's sensor (the phone's own lock-screen prompt). Later, the admin menu's **Save a
   fingerprint** item does the same for a worker who is already enrolled.
   When you are done press **Back to clock-in**; that signs you out.
6. **Clock in and clock out.** The worker presses **Start shift**, looks at
   the camera and turns their head the way the phone asks (left or right, at
   random). The phone greets them by name for two seconds. **End shift** works
   the same way. A worker with a saved fingerprint can touch the sensor
   instead when the phone offers it.
7. **The stranger test.** Somebody who is not enrolled presses **Start shift**
   and does the head turn. Expect **"Not recognised. Please try again."** and
   no punch on the dashboard.
8. **The printed-photo test.** Hold a printed photo, or a photo on another
   phone, in front of the camera and press **Start shift**. Expect a refusal:
   a photograph cannot do the head turn the phone asks for, and the liveness
   check refuses a flat picture. Nothing is recorded.

## Where to see each result on the dashboard

9. **Employees → the worker → Biometrics panel:** the face ("In use" after a
   pass, "Waiting for review on the dashboard" when held) and the fingerprint
   ("in use" once saved), with the consent record.
   **Attendance:** the live punch board shows each clock-in and clock-out as
   it happens, with the device and the method.
   **Devices → the device → Attempts on this kiosk:** every attempt, including
   the stranger and the photo, with why it was refused.
   **Duplicate faces:** faces held for review (see below).
   **Ghost detection:** anything the eleven rules flagged overnight.

## The two reasons an enrolment or a fingerprint stops

- **The face looks like someone already enrolled.** The phone says "This face
  looks like someone already enrolled. An administrator can review it on the
  dashboard under Duplicate faces." The worker stays *Pending enrollment*
  until an administrator decides it there (any administrator may, including
  the one who enrolled the face). Once the review is cleared, the fingerprint
  can be saved for them on the phone. If the review finds it really was the
  same person twice, the duplicate record is blocked; **Lift the block** on
  its biometrics panel lets it enrol again from scratch.
- **Fingerprints are switched off for this device.** The admin menu then shows
  "Fingerprints are switched off for this kiosk. An administrator can switch
  them on in Dashboard → Devices → this device." instead of the **Save a
  fingerprint** item. Tick the fingerprint box on the device's page, wait for
  the next heartbeat (up to a minute), and the item appears.

## Switching between devices on one phone

A phone can hold more than one registered device, which is how a few phones
stand in for a fleet. On the phone: **Admin** → sign in → **Kiosk settings**.
**Add a device** opens the same set-up form as the first time (steps 1 to 3
again, for the new device). The list shows every device stored on the phone,
newest first, with the active one marked **Active now**; tap **Switch to …**
to act as another one. **Forget this device** removes the active one and
falls back to the next stored device, or to the set-up form if none is left.
Forgetting a device on the phone does not switch it off on the dashboard; do
that too when a phone leaves service.
