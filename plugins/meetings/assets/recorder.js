// The recorder Meetings uses, and any other screen that records on this computer can load it too, from
// /plugins/meetings/assets/recorder.js while Meetings is on. It records your mic, and with mode "mac" the computer's
// sound as well: you on the left channel and everyone else on the right, so the transcript can say who spoke. The
// audio goes up in five-second pieces while it records, so nothing is lost if the page goes away.
window.cockpitRecorder = (() => {
  const toData = (blob) =>
    new Promise((ok, fail) => {
      const r = new FileReader();
      r.onload = () => ok(r.result);
      r.onerror = () => fail(r.error);
      r.readAsDataURL(blob);
    });

  // how loud one side is right now, from 0 to 1, for a meter
  const level = (side) => {
    if (!side) return 0;
    const buf = new Uint8Array(side.a.fftSize);
    side.a.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    return Math.min(1, peak / 90);
  };

  const stopAll = (...streams) => streams.forEach((s) => s?.getTracks().forEach((t) => t.stop()));

  /**
   * Starts recording. begin(type) tells your server a recording is starting and returns what it answers (a
   * recording id, say); piece(info, dataUrl) sends one piece of audio; onAnswer, when given, gets what each piece's
   * request answered. noSound is the message for a share that came without its audio.
   * Returns the recording: info, startedAt, you and them (for level), err (the last piece that failed to send) and
   * stop(), which waits for every piece to go up.
   */
  async function start({ mode, bitrate = 48000, begin, piece, onAnswer, noSound }) {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: mode === "mac", noiseSuppression: true, autoGainControl: true } });
    let sys;
    if (mode === "mac") {
      try {
        sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      } catch {
        stopAll(mic);
        throw new Error("Couldn't get the computer's sound. In the cockpit app, allow Screen Recording for cockpit in System Settings; in a browser, share a screen or tab with its audio on.");
      }
      sys.getVideoTracks().forEach((t) => t.stop());
      if (!sys.getAudioTracks().length) {
        stopAll(mic, sys);
        throw new Error(noSound || "The share came without its sound, so only you would be recorded. Share again with audio on, or record the mic only.");
      }
    }
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const merger = ctx.createChannelMerger(2);
    const meter = (stream) => {
      const src = ctx.createMediaStreamSource(stream);
      const a = ctx.createAnalyser();
      a.fftSize = 512;
      src.connect(a);
      return { src, a };
    };
    const you = meter(mic);
    const them = sys ? meter(new MediaStream(sys.getAudioTracks())) : undefined;
    you.src.connect(merger, 0, 0);
    if (them) them.src.connect(merger, 0, 1);
    merger.connect(dest);
    const type = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
    const recorder = new MediaRecorder(sys ? dest.stream : mic, type ? { mimeType: type, audioBitsPerSecond: bitrate } : undefined);
    let info;
    try {
      info = await begin(type);
    } catch (e) {
      stopAll(mic, sys);
      ctx.close();
      throw e;
    }
    const rec = { info, startedAt: Date.now(), you, them, err: undefined };
    // pieces go up one after another, in order
    let queue = Promise.resolve();
    recorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      const blob = e.data;
      queue = queue.then(async () => {
        try {
          const answer = await piece(info, await toData(blob));
          rec.err = undefined;
          // outside the queue, so an answer that stops the recording doesn't wait on itself
          if (onAnswer) setTimeout(() => onAnswer(answer));
        } catch (err) {
          rec.err = err.message;
        }
      });
    };
    recorder.start(5000);
    rec.stop = async () => {
      if (recorder.state !== "inactive")
        await new Promise((ok) => {
          recorder.onstop = ok;
          recorder.stop();
        });
      stopAll(mic, sys);
      ctx.close();
      await queue;
    };
    return rec;
  }

  return { start, level, toData };
})();
