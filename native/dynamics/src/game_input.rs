//! Atomic admission of live and recorded vehicle controls.
use super::*;

impl GameState {
    // Every mounted control uses the gun and feed that the construction actually carries.
    pub(super) fn configure_mounted(&self, module: &Module, config: &mut Value) {
        config["platform"] = json!("vehicle");
        config["preset"] = json!(module.weapon_preset);
        config["id"] = self.catalogue[&module.weapon_preset]["family"].clone();
        config["componentId"] = module.cold["id"].clone();
        if let Some(ammo) = module.weapon_ammo(&self.catalogue) {
            config["ammo"] = json!(ammo);
        }
    }
    fn weapon_controls(input: &Value) -> Result<(), String> {
        for key in ["aimAngle", "fuzeTime"] {
            if input.get(key).is_some() && !input[key].as_f64().is_some_and(|x| x.is_finite()) {
                return Err(format!("Controle de arma inválido: {key}"));
            }
        }
        if input.get("charge").is_some()
            && !input["charge"].as_f64().is_some_and(|x| x.is_finite())
            && !(input["charge"] == "auto" && input.get("aimAngle").is_none())
        {
            return Err("Controle de arma inválido: charge".into());
        }
        Ok(())
    }
    /// The share of what its brakes give that a command asks a vehicle to brake with, from none to all of it: `absent`
    /// where it says nothing of them.
    pub(super) fn brake_share(input: &Value, absent: f64) -> Result<f64, String> {
        match input.get("brake") {
            None => Ok(absent),
            Some(brake) => brake.as_f64().filter(|x| x.is_finite()).map(|x| x.clamp(0.0, 1.0)).ok_or_else(|| "Freio inválido.".into()),
        }
    }
    pub(super) fn admitted_aim(&self, aim: &Value) -> Result<Point, String> {
        let x = aim["x"].as_f64().filter(|x| x.is_finite()).ok_or("Mira inválida.")?;
        let y = aim["y"].as_f64().filter(|y| y.is_finite()).ok_or("Mira inválida.")?;
        // An aim is a point to send a round through, not a place the round must
        // stay under or over: it may be put far above the field or into its
        // ground. Held to a ceiling, as it once was, a barrel raised at a point
        // in the sky pointed below it; held to a floor, a gun in a valley was
        // laid above the point under it.
        Ok(Point::new(
            x.clamp(self.bounds.min_x, self.bounds.max_x),
            y.clamp(-AIM_SKY, AIM_SKY),
        ))
    }
    pub(super) fn input(
        &mut self,
        core: &mut NativeWorld,
        index: usize,
        input: &Value,
        force: bool,
    ) -> Result<Value, String> {
        let kind = input["type"].as_str().ok_or("Comando de pilotagem inválido.")?;
        let phase = input["phase"].as_str().filter(|p| matches!(*p, "before" | "decision"))
            .ok_or("Fase do comando gravado inválida.")?;
        let controls = kind == "controls";
        if controls && input.get("active").is_some() {
            return Err("Campo active indisponível para controles; use fire.".into());
        }
        if kind == "release" {
            if input.get("cancel").is_some_and(|value| !value.is_boolean()) {
                return Err("Comando de liberação inválido: cancel".into());
            }
            let (_, brake) = self.tow_controls(self.actors[index].handle, 0.0, Self::brake_share(input, 1.0)?);
            let cancel = input["cancel"] != false;
            let a = &mut self.actors[index];
            a.release(cancel);
            if let Some(defeated) = input["defeated"].as_bool() {
                a.defeated = defeated;
            }
            if let Some(d) = &mut a.drive {
                d.control(0.0, brake);
                d.climb_asked(0.0);
            }
            let mut record = json!({"type":"release","phase":phase});
            if brake < 1.0 { record["brake"] = json!(brake); }
            if !cancel { record["cancel"] = json!(false); }
            return Ok(json!({"accepted":true,"record":record}));
        }
        if self.actors[index].defeated {
            return Ok(json!({"accepted":false,"record":{"type":"release","phase":phase}}));
        }
        if !matches!(kind, "controls" | "drive" | "aim" | "trigger" | "fire") {
            return Err("Comando de pilotagem inválido.".into());
        }
        let mut record = json!({"type":kind,"phase":phase});
        let mut movement = None;
        if controls || kind == "drive" {
            let throttle = input["throttle"]
                .as_f64()
                .filter(|x| x.is_finite())
                .ok_or("Acelerador inválido; ação de pilotagem inválida.")?
                .clamp(-1.0, 1.0);
            let brake = Self::brake_share(input, 0.0)?;
            // How hard a vehicle that flies is asked to climb, down below zero: none where the command says nothing of it.
            let rise = match input.get("rise") {
                None => 0.0,
                Some(rise) => rise.as_f64().filter(|x| x.is_finite()).ok_or("Subida inválida.")?.clamp(-1.0, 1.0),
            };
            movement = Some((throttle, brake, rise));
            record["throttle"] = json!(throttle);
            record["brake"] = json!(brake);
            if rise != 0.0 {
                record["rise"] = json!(rise);
            }
        }
        let active = if controls {
            input["fire"].as_bool().ok_or("Disparo de controle inválido.")?
        } else if kind == "trigger" {
            input["active"].as_bool().ok_or("Gatilho inválido.")?
        } else {
            false
        };
        let shot = kind == "fire" || input["shot"] == true;
        let queue = input["queue"] == true;
        let cancel = input["cancel"] == true;
        if kind == "trigger"
            && !active
            && !shot
            && input.get("aim").is_none()
            && [
                "id",
                "preset",
                "componentId",
                "ammo",
                "trajectory",
                "aimAngle",
                "charge",
                "detonation",
                "fuzeTime",
            ]
            .iter()
            .all(|key| input.get(*key).is_none())
        {
            let a = &mut self.actors[index];
            a.trigger = None;
            if let Some(defeated) = input["defeated"].as_bool() {
                a.defeated = defeated;
            }
            if cancel {
                a.pending = None;
            }
            for e in &mut a.also {
                e.held = false;
                if cancel {
                    e.pending = None;
                }
            }
            record["active"] = json!(false);
            record["shot"] = json!(false);
            record["queue"] = json!(queue);
            record["cancel"] = json!(cancel);
            return Ok(json!({"accepted":true,"record":record}));
        }
        let mut aim = self.actors[index].aim;
        let mut settings = None;
        let mut unavailable_weapon = false;
        let mut extras = Vec::new();
        if kind != "drive" {
            Self::weapon_controls(input)?;
            if input.get("aim").is_some() || kind != "trigger" || active || shot {
                aim = self.admitted_aim(&input["aim"])?;
                record["aim"] = aim.to_value();
            }
            let is_mounted = input["platform"] == "vehicle";
            let mut config = input.clone();
            config["platform"] = json!(if is_mounted { "vehicle" } else { "ground" });
            let mounted = if is_mounted {
                self.damage.modules.iter().find(|m| {
                    m.actor == self.actors[index].handle
                        && m.kind == ComponentKind::Weapon
                        && m.usable()
                        && input["componentId"]
                            .as_str()
                            .is_none_or(|id| m.cold["id"] == id)
                })
            } else {
                None
            };
            if let Some(m) = mounted {
                self.configure_mounted(m, &mut config);
            }
            unavailable_weapon = is_mounted && mounted.is_none();
            // The gun of the vehicle is in hand: nobody looks for it by its name over the pieces of the field.
            let mut resolved = match mounted {
                Some(m) => Some(Settings::admit(&self.catalogue, &config, Some(m.owner), true)?),
                None if unavailable_weapon => None,
                None => Some(self.settings(&config, true)?),
            };
            if let Some(settings) = &mut resolved { settings.requires_alignment = phase == "decision"; }
            let recorded_settings = resolved.as_ref().map_or(&config, |settings| &settings.value);
            for key in [
                "platform",
                "componentId",
                "ammo",
                "trajectory",
                "aimAngle",
                "charge",
                "detonation",
                "fuzeTime",
            ] {
                if let Some(value) = recorded_settings.get(key) {
                    record[key] = value.clone();
                }
            }
            record["active"] = json!(active);
            record["shot"] = json!(shot);
            record["queue"] = json!(queue);
            record["cancel"] = json!(cancel);
            // The other guns fired along with this one. Each is laid and reloads on
            // its own; one that is gone, or named twice, is left out of the command.
            if let Some(list) = input.get("also") {
                let list = list.as_array().filter(|list| list.len() <= 15)
                    .ok_or("Controle de arma inválido: also")?;
                let lead = resolved.as_ref().filter(|s| s.mounted).and_then(|s| s.component);
                let mut recorded = Vec::new();
                for entry in list {
                    let id = entry["componentId"].as_str().ok_or("Controle de arma inválido: also")?;
                    Self::weapon_controls(entry)?;
                    if entry.get("fire").is_some_and(|fire| !fire.is_boolean()) {
                        return Err("Controle de arma inválido: also".into());
                    }
                    let own = if entry.get("aim").is_some() { Some(self.admitted_aim(&entry["aim"])?) } else { None };
                    let Some(m) = self.damage.modules.iter().find(|m| {
                        m.actor == self.actors[index].handle
                            && m.kind == ComponentKind::Weapon
                            && m.usable()
                            && m.cold["id"] == id
                    }) else {
                        continue;
                    };
                    if lead == Some(m.owner) || extras.iter().any(|e: &Extra| e.settings.component == Some(m.owner)) {
                        continue;
                    }
                    let mut config = entry.clone();
                    self.configure_mounted(m, &mut config);
                    let mut settings = Settings::admit(&self.catalogue, &config, Some(m.owner), true)?;
                    settings.requires_alignment = phase == "decision";
                    let mut kept = json!({});
                    for key in ["componentId", "ammo", "trajectory", "aimAngle", "charge", "detonation", "fuzeTime"] {
                        if let Some(value) = settings.value.get(key) {
                            kept[key] = value.clone();
                        }
                    }
                    if let Some(own) = own {
                        kept["aim"] = own.to_value();
                    }
                    if let Some(fire) = entry.get("fire") {
                        kept["fire"] = fire.clone();
                    }
                    recorded.push(kept);
                    extras.push(Extra {
                        aim: own.unwrap_or(aim),
                        settings,
                        held: entry["fire"].as_bool().unwrap_or(active),
                        pending: None,
                    });
                }
                if !recorded.is_empty() {
                    record["also"] = json!(recorded);
                }
            }
            settings = resolved;
        }
        // Admit the whole patch before changing movement or armament.
        if let Some(defeated) = input["defeated"].as_bool() {
            self.actors[index].defeated = defeated;
        }
        if let Some((throttle, brake, rise)) = movement {
            let (throttle, brake) = self.tow_controls(self.actors[index].handle, throttle, brake);
            if let Some(d) = &mut self.actors[index].drive {
                d.control(throttle, brake);
                d.climb_asked(rise);
            }
        }
        let mut accepted = !(unavailable_weapon && (active || shot));
        if unavailable_weapon && (controls || kind == "trigger") {
            self.actors[index].trigger = None;
            if cancel { self.actors[index].pending = None; }
        }
        if kind != "drive" {
            // The command is the whole of the actor's fire: a gun it no longer names
            // is let go. One it still names keeps the trigger a mere aim does not
            // touch, and the shot waiting for the same laying.
            let old = std::mem::take(&mut self.actors[index].also);
            for e in &mut extras {
                let before = old.iter().find(|o| o.settings.component == e.settings.component);
                if !(controls || kind == "trigger") {
                    e.held = before.is_some_and(|o| o.held);
                }
                if !cancel {
                    e.pending = before
                        .filter(|o| same_shot(e.aim, &e.settings, o.aim, &o.settings))
                        .and_then(|o| o.pending);
                }
            }
            self.actors[index].also = extras;
            // A trigger held on the guns that are left is a command obeyed.
            accepted |= !shot && self.actors[index].also.iter().any(|e| e.held);
        }
        if let Some(settings) = &settings {
            if cancel {
                self.actors[index].pending = None;
            }
            self.update_aim(index, aim, settings);
            let a = &mut self.actors[index];
            if controls || kind == "trigger" {
                a.trigger = if active {
                    Some((aim, settings.clone()))
                } else {
                    None
                };
            } else if kind == "aim" && a.trigger.is_some() {
                a.trigger = Some((aim, settings.clone()));
            }
        }
        if settings.is_some() || !self.actors[index].also.is_empty() {
            self.advance_weapons(0.0, Some(self.actors[index].handle));
        }
        if let Some(settings) = settings {
            if shot {
                accepted = self.fire(core, index, aim, &settings, force)?;
                if !accepted && queue {
                    self.queue_pending(index, aim, settings);
                }
            }
        }
        if shot {
            for k in 0..self.actors[index].also.len() {
                let (aim, settings) = (self.actors[index].also[k].aim, self.actors[index].also[k].settings.clone());
                if self.launch(core, index, aim, &settings, force)? {
                    self.actors[index].also[k].pending = None;
                    accepted = true;
                } else if queue && self.waits_for_servo(index, aim, &settings) {
                    self.actors[index].also[k].pending = Some(self.time + 12.0);
                }
            }
        }
        if controls {
            record["fire"] = json!(active);
            record.as_object_mut().unwrap().remove("active");
        }
        Ok(json!({"accepted":accepted,"record":record}))
    }
}
