export const GUIDE_HTML = `
<div class="guide">
  <h2>Hookup guide</h2>
  <p class="lead">No audio interface needed. Pick the first option your gear allows. Every option keeps
  the browser's echo cancellation, noise suppression and auto-gain off.</p>

  <h3>Guitar / amp → phone</h3>
  <div class="opt card">
    <b>A. Marshall CODE USB → Android ($0–8, try first)</b>
    <div class="diagram">guitar ─► CODE 50 ─USB─► OTG adapter ─► phone USB-C</div>
    <p>A USB-B (or mini-USB, depending on your CODE) to USB-C OTG cable. The CODE works as a driverless
    USB audio input on computers. On phones it's <i>unverified</i>, so JamLink lists a "USB Audio" input
    only if your phone sees it. You get the amp's full modelled tone, clean and at line level.</p>
  </div>
  <div class="opt card">
    <b>B. CODE PHONES out → phone mic input (~$10, works everywhere)</b>
    <div class="diagram">CODE PHONES ─3.5mm─► TRRS splitter (CTIA) mic ─► phone
                                     or USB-C headset adapter with mic in</div>
    <p><b>Start with the amp volume low.</b> Phone mic inputs expect a microphone, not line level, and clip
    easily. Raise the amp slowly while watching the clip light in Setup. A cheap inline attenuator helps.</p>
  </div>
  <div class="opt card">
    <b>C. Phone mic near the speaker ($0)</b>
    <div class="diagram">CODE speaker ─air─► phone mic</div>
    <p>Works anywhere. Put the phone 20–50 cm from the speaker, off-axis. You'll get some room sound.</p>
  </div>

  <h3>Phone → your ears</h3>
  <div class="opt card">
    <p><b>Best: wired headphones.</b> Or phone headphone out → <b>CODE AUX IN</b>, so your partner plays
    through your amp alongside you. The phone speaker works for a quick test.</p>
    <p><b>Avoid Bluetooth</b> (including the CODE's own Bluetooth streaming): it adds 150–300 ms, far over
    the 60 ms budget. JamLink warns when it detects it.</p>
    <p><b>Feedback:</b> with option C, don't play your partner through the amp. The mic would send it back.
    Use headphones, or option A/B.</p>
  </div>

  <h3>Getting under 60 ms</h3>
  <ul>
    <li>Run the device latency test on both phones. It measures the part no setting can fix.</li>
    <li>5 GHz Wi-Fi near the router (or a laptop on Ethernet). Close other apps that use the network.</li>
    <li>Chrome on Android, or Chrome/Firefox on a laptop. A laptop is the fallback if a phone's audio path is slow.</li>
    <li>Leave "Keep under 60 ms" on: JamLink caps its own buffering so the total stays in budget,
    accepting a rare tiny glitch instead of extra delay.</li>
    <li>Use the synced metronome: both phones click from a shared clock, so you both lock to the same grid.</li>
  </ul>
</div>`;
