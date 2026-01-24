//! Audio utilities for playing notification sounds.
//!
//! This module provides cross-platform audio playback for notifications.
//! On web, it uses the Web Audio API to generate a simple notification tone.

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::JsCast;

    /// Play the notification sound for new messages using Web Audio API.
    /// Generates a simple two-tone notification sound.
    pub fn play_notification() {
        // Try to play an mp3 file first, fall back to generated tone
        if try_play_audio_file() {
            return;
        }

        play_generated_tone();
    }

    /// Try to play a notification sound from an audio file.
    fn try_play_audio_file() -> bool {
        let Some(window) = web_sys::window() else {
            return false;
        };
        let Some(document) = window.document() else {
            return false;
        };

        // Try to get an existing audio element or create one
        let audio: web_sys::HtmlAudioElement = match document
            .get_element_by_id("notification-audio")
            .and_then(|el| el.dyn_into::<web_sys::HtmlAudioElement>().ok())
        {
            Some(existing) => existing,
            None => {
                // Create a new audio element with the notification sound
                match web_sys::HtmlAudioElement::new_with_src("/assets/sounds/notification.mp3") {
                    Ok(audio) => {
                        audio.set_id("notification-audio");
                        audio.set_volume(0.5);
                        audio
                    }
                    Err(_) => return false,
                }
            }
        };

        // Check if the audio file is loadable
        // network_state: 0 = NETWORK_EMPTY, 1 = NETWORK_IDLE, 2 = NETWORK_LOADING, 3 = NETWORK_NO_SOURCE
        if audio.network_state() == 3 {
            return false;
        }

        audio.set_current_time(0.0);
        audio.play().is_ok()
    }

    /// Generate and play a simple notification tone using Web Audio API.
    fn play_generated_tone() {
        // Create audio context
        let audio_context = match web_sys::AudioContext::new() {
            Ok(ctx) => ctx,
            Err(e) => {
                crate::log_info!("Failed to create AudioContext: {:?}", e);
                return;
            }
        };

        // Check if context is suspended (browsers require user interaction)
        if audio_context.state() == web_sys::AudioContextState::Suspended {
            // Try to resume - this may fail without user interaction
            let _ = audio_context.resume();
        }

        let current_time = audio_context.current_time();

        // Create gain node for volume control and envelope
        let gain = match audio_context.create_gain() {
            Ok(g) => g,
            Err(_) => return,
        };

        // Set up volume envelope (quick attack, short decay)
        let gain_param = gain.gain();
        gain_param.set_value_at_time(0.0, current_time).ok();
        gain_param.linear_ramp_to_value_at_time(0.3, current_time + 0.01).ok();
        gain_param.exponential_ramp_to_value_at_time(0.01, current_time + 0.15).ok();

        // Connect gain to output
        gain.connect_with_audio_node(&audio_context.destination()).ok();

        // First tone (higher pitch)
        if let Ok(osc1) = audio_context.create_oscillator() {
            osc1.set_type(web_sys::OscillatorType::Sine);
            osc1.frequency().set_value(880.0); // A5
            osc1.connect_with_audio_node(&gain).ok();
            osc1.start_with_when(current_time).ok();
            osc1.stop_with_when(current_time + 0.08).ok();
        }

        // Second tone (slightly lower, starts after first)
        if let Ok(osc2) = audio_context.create_oscillator() {
            osc2.set_type(web_sys::OscillatorType::Sine);
            osc2.frequency().set_value(659.25); // E5
            osc2.connect_with_audio_node(&gain).ok();
            osc2.start_with_when(current_time + 0.08).ok();
            osc2.stop_with_when(current_time + 0.15).ok();
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod native {
    /// Play the notification sound for new messages (desktop stub).
    /// Desktop audio playback would require additional dependencies like rodio.
    pub fn play_notification() {
        // Desktop audio not yet implemented
        // Could use rodio or similar crate in the future
    }
}

#[cfg(target_arch = "wasm32")]
pub use wasm::play_notification;

#[cfg(not(target_arch = "wasm32"))]
pub use native::play_notification;
