//! Command queries and controlled mutations at the game boundary.
use super::*;

impl GameState {
    pub(super) fn command_alliances(&mut self, r: &Value) -> Result<Value, String> {
        let rows = r["pairs"].as_array().ok_or("Intelligence pairs must be an array")?;
        let mut pairs = Vec::new();
        for row in rows {
            let pair = row.as_array().filter(|pair| pair.len() == 2).ok_or("Invalid intelligence pair")?;
            let a = pair[0].as_str().filter(|name| !name.is_empty()).ok_or("Invalid intelligence faction")?;
            let b = pair[1].as_str().filter(|name| !name.is_empty() && *name != a).ok_or("Invalid intelligence faction")?;
            let next = if a < b { (a.to_owned(),b.to_owned()) } else { (b.to_owned(),a.to_owned()) };
            if !pairs.contains(&next) { pairs.push(next); }
        }
        pairs.sort();
        self.sensors.set_alliances(pairs);
        Ok(json!(true))
    }
    pub(super) fn command_material(&mut self, r: &Value) -> Result<Value, String> {
        if let Some(module) = self.damage.module(id(r, "owner")) {
            let point = r
                .get("point")
                .map(Point::from_value)
                .unwrap_or(Point::new(module.pose.x, module.pose.y));
            let servo = crate::game_motion::ServoProfile::from_module(module);
            let resistance = r.get("end").map_or_else(
                || module.resistance(point,number(r,"depth",module.width),number(r,"directionScale",1.0)),
                |end|module.chord_resistance(point,Point::from_value(end),number(r,"depth",module.width),number(r,"directionScale",1.0)));
            return Ok(
                json!({"mass":module.physical_mass,"uv":module.material_uv(point),
                "resistance":resistance,
                "physicalCenterLocal":module.physical_center,"physicalInertia":module.physical_inertia,
                "servo":{"maxSpeed":servo.max_speed,"torqueNm":0.0,
                    "minOffset":module.mount.as_ref().map(|m|m.min),"maxOffset":module.mount.as_ref().map(|m|m.max)}}),
            );
        }
        let plate = self
            .damage
            .plate(id(r, "owner"))
            .ok_or("Unknown material owner")?;
        let point = r
            .get("point")
            .map(Point::from_value)
            .unwrap_or_else(|| plate.pose.world_point(plate.properties.center));
        return Ok(
            json!({"area":plate.properties.area,"mass":plate.mass(),"inertia":plate.inertia(),
            "center":plate.properties.center,"resistanceScale":plate.resistance_scale(point),"uv":plate.material_uv(point)}),
        );
    }
    pub(super) fn command_ray(&mut self, op: &str, r: &Value) -> Result<Value, String> {
        let start = Point::from_value(&r["start"]);
        let end = Point::from_value(&r["end"]);
        if ![start.x, start.y, end.x, end.y]
            .iter()
            .all(|n| n.is_finite())
        {
            return Err("Invalid material ray".into());
        }
        let ignored = array(r, "ignoreOwners")
            .iter()
            .filter_map(Value::as_u64)
            .map(|n| n as u32)
            .collect::<Vec<_>>();
        let options = RayOptions {
            projectile: r["projectile"] == true,
            ignore_ids: &ignored,
            complete_exit: r["completeExit"] != false,
            ..Default::default()
        };
        let packet = |hit: crate::game_geometry::RayHit| {
            json!({"owner":hit.owner,"actor":hit.actor,
            "kind":match hit.kind {EntityKind::Plate=>"plate",EntityKind::Module=>"module"},
            "point":hit.point,"exitPoint":hit.exit_point,"normal":hit.normal,"enter":hit.enter,"exit":hit.exit,"depth":hit.depth})
        };
        return Ok(if op == "raycast" {
            self.geometry
                .raycast(start, end, &options)
                .map(packet)
                .unwrap_or(Value::Null)
        } else {
            json!(
                self.geometry
                    .raycast_layers(start, end, &options)
                    .into_iter()
                    .map(packet)
                    .collect::<Vec<_>>()
            )
        });
    }
    pub(super) fn command_physics(&mut self, core: &mut NativeWorld, r: &Value) -> Result<Value, String> {
        let body_state = |body: &rapier2d_f64::prelude::RigidBody| {
            let p = body.translation();
            let v = body.linvel();
            let c = body.center_of_mass();
            json!({"x":p.x,"y":p.y,"angle":body.rotation().angle(),"vx":v.x,"vy":v.y,"omega":body.angvel(),
                "center":{"x":c.x,"y":c.y},"centerX":c.x,"centerY":c.y,"mass":body.mass(),
                "inertia":body.mass_properties().local_mprops.principal_inertia(),"dynamic":body.is_dynamic(),"sleeping":body.is_sleeping()})
        };
        let owners = self.bindings.iter().map(|binding| {
            let state = core.bodies.get(&binding.body).and_then(|h| core.world.bodies.get(*h)).map(body_state);
            json!({"owner":binding.owner,"body":binding.body,"colliders":binding.colliders.len(),"state":state})
        }).collect::<Vec<_>>();
        let body_states = core
            .bodies
            .iter()
            .map(|(id, handle)| {
                let mut state = body_state(&core.world.bodies[*handle]);
                state["handle"] = json!(id);
                state["actor"] = json!(
                    self.actors
                        .iter()
                        .find(|actor| actor.body == *id)
                        .map(|actor| actor.handle)
                );
                state
            })
            .collect::<Vec<_>>();
        let kinetic = core
            .world
            .bodies
            .iter()
            .map(|(_, b)| crate::Motion::capture(b).energy())
            .sum::<f64>();
        let gravity = core
            .world
            .bodies
            .iter()
            .filter(|(_, b)| b.is_dynamic())
            .map(|(_, b)| -b.mass() * b.center_of_mass().dot(core.world.gravity))
            .sum::<f64>();
        let spring = self.gears.iter().map(|gear| gear.carried.work).sum::<f64>();
        let mut output = json!({"bodies":core.bodies.len(),"colliders":core.colliders.len(),
            "recoveries":self.recoveries,"owners":owners,"bodyStates":body_states,"energy":core.energy_audit.to_value()});
        output["energyStoredJ"] = json!({"kinetic":kinetic,"gravity":gravity,"spring":spring,"total":kinetic+gravity+spring});
        if r["contacts"] == true {
            let view = &*core;
            let contacts = view.world.narrow_phase.contact_pairs().flat_map(|pair| pair.manifolds().iter().map(move |m| {
                let contacts = m.points.iter().map(|c| json!({"point1":{"x":c.local_p1.x,"y":c.local_p1.y},
                    "point2":{"x":c.local_p2.x,"y":c.local_p2.y},"dist":c.dist,"impulse":c.data.impulse})).collect::<Vec<_>>();
                let solver = m.data.solver_contacts.iter().map(|c| {
                    let (a,b)=m.data.solver_contact_world_points(c,&view.world.bodies);let point=(a+b)*0.5;
                    json!({"point":{"x":point.x,"y":point.y},"dist":c.dist})
                }).collect::<Vec<_>>();
                json!({"ownerA":view.metadata.get(&pair.collider1).map(|m|m.object),"ownerB":view.metadata.get(&pair.collider2).map(|m|m.object),
                    "normal":{"x":m.data.normal.x,"y":m.data.normal.y},"contacts":contacts,"solverContacts":solver,
                    "impulse":m.points.iter().map(|c|c.data.impulse).sum::<f64>(),
                    "penetration":m.points.iter().map(|c|(-c.dist).max(0.0)).fold(0.0,f64::max)})
            })).collect::<Vec<_>>();
            output["contactStates"] = json!(contacts);
        }
        if r["resetEnergy"] == true {
            core.energy_audit = Default::default();
        }
        return Ok(output);
    }
    pub(super) fn command_scripted(&mut self, r: &Value) -> Result<Value, String> {
        self.scripted_entries(std::slice::from_ref(r)).pop().unwrap()
    }
    pub(super) fn command_scripted_batch(&mut self, r: &Value) -> Result<Value, String> {
        let requests = r["requests"].as_array().ok_or("Pilot requests must be an array")?;
        if requests.len() > self.actors.len() { return Err("Pilot batch exceeds actor count".into()); }
        Ok(json!(self.scripted_entries(requests).into_iter().map(|result| match result {
            Ok(value) => json!({"result":value}), Err(error) => json!({"error":error}),
        }).collect::<Vec<_>>()))
    }
    pub(super) fn command_line(&mut self, r: &Value) -> Result<Value, String> {
        let index = self.actor_index(r)?;
        let handle = self.actors[index].handle;
        let aim = self.admitted_aim(&r["aim"])?;
        let sides = self.sides();
        let (near, allies) = self.spans_with_sides(handle, &sides);
        let gun = self.damage.modules.iter().find(|m| {
            m.actor == handle && m.kind == ComponentKind::Weapon && m.usable() && m.cold["id"] == r["componentId"]
        }).ok_or("Arma não encontrada.")?;
        let mut config = json!({});
        self.configure_mounted(gun, &mut config);
        for key in ["trajectory", "charge"] {
            if !r[key].is_null() {
                config[key] = r[key].clone();
            }
        }
        let s = Settings::admit(&self.catalogue, &config, Some(gun.owner), true)?;
        let origin = Point::new(gun.pose.x, gun.pose.y);
        let drive = self.actors[index].drive.as_ref();
        let (pivot, omega) = (drive.map_or(Point::ZERO, |d| d.velocity_at(origin)), drive.map_or(0.0, |d| d.omega));
        let muzzle = solution_with_motion(origin, aim, &s, None, pivot, omega, mount_sector(gun));
        if !muzzle.reachable {
            return Ok(Value::Null);
        }
        let (inherited, velocity) = (drive.map_or(Point::ZERO, |d| d.velocity_at(muzzle.point)),
            crate::game_weapons::launch_velocity(muzzle.angle, muzzle.speed));
        let line = LineOfFire { gun: gun.owner, point: muzzle.point, velocity: Point::new(velocity.x + inherited.x, velocity.y + inherited.y),
            drag: s.drag, ammo: Ammo::from_name(&s.ammo), power: s.power };
        return Ok(match line_of_fire(sides.wrecks(), &line, muzzle.time, (handle, near), &allies, ROUND_STEP, &self.damage, &self.geometry, &self.terrain) {
            Line::Own => json!("own"),
            Line::Ally => json!("ally"),
            Line::Clear => Value::Null,
        });
    }
    pub(super) fn command_sight(&mut self, r: &Value) -> Result<Value, String> {
        self.refresh_sensors();
        sensor_view!(self => view);
        let ghosts = array(r, "ghosts")
            .iter()
            .map(|ghost| {
                let place = Point::new(number(ghost, "x", f64::NAN), number(ghost, "y", f64::NAN));
                (text(ghost, "team", "").to_owned(), place)
            })
            .collect::<Vec<_>>();
        let (sight, cleared) = self.sensors.team_sight(&view, &ghosts);
        self.remember_optical_availability(&sight);
        let named = |handle: u32| self.actors.iter().find(|a| a.handle == handle).map(|a| a.id.as_str());
        let sight = sight
            .into_iter()
            .map(|(team, held)| {
                let held = held
                    .iter()
                    .map(|s| {
                        let mut value = json!({"actorId":named(s.target),"channel":s.channel.name(),"visible":s.visible,
                            "x":s.x,"y":s.y,"error":s.error,"age":s.age,"by":s.by.and_then(named)});
                        // The team is a private receipt origin, resolved by the host to public faction identity.
                        if let Some(receipt) = &s.sound && receipt.team != team { value["report"] = json!({"team":receipt.team,"side":receipt.side}); }
                        value
                    })
                    .collect::<Vec<_>>();
                (team, json!(held))
            })
            .collect::<serde_json::Map<_, _>>();
        let cleared = cleared
            .into_iter()
            .map(|index| json!({"team":ghosts[index].0,"actorId":array(r, "ghosts")[index]["actorId"]}))
            .collect::<Vec<_>>();
        return Ok(json!({"sight":sight,"cleared":cleared}));
    }
    pub(super) fn command_projectile(&mut self, r: &Value) -> Result<Value, String> {
        let mut p = Projectile::from_value(&r["projectile"])?;
        let previous = self.projectiles.projectiles.iter().position(|old| {
            (p.id != 0 && old.id == p.id)
                || r["projectile"]["id"].is_string() && old.cold["id"] == r["projectile"]["id"]
        });
        if let Some(index) = previous {
            p = self.projectiles.projectiles.remove(index);
        }
        if p.id == 0 {
            p.id = self.projectiles.allocate_id();
        }
        let result = json!({"projectile":p.to_value()});
        self.projectiles.projectiles.push(p);
        return Ok(result);
    }
    pub(super) fn command_state(&mut self, core: &mut NativeWorld, op: &str, r: &Value) -> Result<Value, String> {
        let index = self.actor_index(r)?;
        let state = r["state"]
            .as_object()
            .ok_or("State patch must be an object")?;
        for (key, value) in state {
            let number = value.as_f64().is_some_and(f64::is_finite);
            let allowed = if op == "setActorState" {
                key == "cooldown" && number || key == "sheltered" && value.is_boolean()
            } else {
                matches!(key.as_str(), "x" | "y" | "angle" | "vx" | "vy" | "omega") && number
            };
            if !allowed {
                return Err("Invalid state patch".into());
            }
        }
        if op == "setActorState" {
            // A construction its base shelters is harmed by nobody's fire and fires none (`Actor::sheltered`).
            if let Some(sheltered) = state.get("sheltered").and_then(Value::as_bool) {
                self.actors[index].sheltered = sheltered;
            }
            if let Some(value) = state.get("cooldown") {
                let (reload, handle) = (value.as_f64().unwrap().max(0.0), self.actors[index].handle);
                self.actors[index].cooldown = reload;
                for servo in &mut self.servos {
                    if self.damage.module(servo.owner).is_some_and(|m| m.actor == handle) {
                        servo.reload = reload;
                    }
                }
            }
        } else {
            self.set_vehicle_state(core, index, state)?;
        }
        self.refresh_sensors();
        return Ok(json!(true));
    }
    fn set_part_state(&mut self, r: &Value) -> Result<(), String> {
        let owner = id(r, "owner");
        let state = r["state"].as_object().ok_or("Part state patch must be an object")?;
        // `cargo` is the whole load of a hopper, a cistern or a supply piece, by material; `barrelDamage`
        // what the barrel of a gun took, which disables it from a share of its health on.
        for (key, value) in state {
            if !match key.as_str() {
                "health" | "rounds" | "fuelLitres" | "barrelDamage" | "elevationDamage" => value.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0),
                "mantletHoles" => value.as_array().is_some_and(|holes| holes.len() <= 48),
                "cargo" => value.is_object(),
                _ => false,
            } {
                return Err("Invalid part state patch".into());
            }
        }
        let module = self.damage.module_mut(owner).ok_or("Unknown component")?;
        let old_health = module.health;
        for (key, value) in state {
            let n = value.as_f64().unwrap_or(0.0);
            match key.as_str() {
                "health" => module.health = n.min(module.max_health),
                "rounds" => module.rounds = (n as u32).min(module.capacity_rounds),
                "fuelLitres" => module.fuel_litres = n.min(module.capacity_litres),
                "barrelDamage" => {
                    module.barrel_damage = n;
                    module.barrel_disabled = n >= module.max_health * BARREL_DISABLED_SHARE;
                }
                "elevationDamage" => {
                    module.elevation_damage = n;
                    module.elevation_disabled = n >= module.max_health * BARREL_DISABLED_SHARE;
                }
                "mantletHoles" => { module.set_mantlet_holes(value)?; module.mark_revision += 1; }
                "cargo" => module.stow(value)?,
                _ => {}
            }
        }
        if module.mount.is_some() { self.geometry.upsert(owner, EntityGeometry::from_module(module)); }
        let repaired = module.health > old_health;
        let actor = module.actor;
        if repaired {
            let share = (module.health - old_health) / (module.max_health - old_health).max(1e-8);
            module.burn_age *= 1.0 - share.clamp(0.0, 1.0);
            crate::game_fire::extinguish(&mut self.damage, actor);
        }
        Ok(())
    }
    /// What the tools of a construction did over `seconds` of the field (`run_tools`): the field says which of them
    /// dug, by their owners, and is told the share of their full pace they dug at and what held them under it. Their
    /// engines burn for it out of its tanks.
    pub(super) fn command_work(&mut self, r: &Value) -> Result<Value, String> {
        let index = self.actor_index(r)?;
        let seconds = r["seconds"].as_f64().filter(|s| s.is_finite() && *s >= 0.0).ok_or("Invalid work time")?;
        let tools = array(r, "tools").iter()
            .map(|owner| owner.as_u64().map(|n| n as u32).ok_or("Invalid tool owner"))
            .collect::<Result<Vec<_>, _>>()?;
        let work = crate::game_motion::run_tools(&mut self.damage, self.actors[index].handle, &tools, seconds);
        Ok(json!({"share":work.share,"limit":work.limit.map(|limit| limit.name())}))
    }
    pub(super) fn command_part_states(&mut self, core: &mut NativeWorld, r: &Value) -> Result<Value, String> {
        let patches = r["patches"].as_array().ok_or("Part state patches must be an array")?;
        // A service can name at most the components already admitted to this world.
        if patches.len() > self.damage.modules.len() { return Err("Part state batch exceeds component count".into()); }
        if patches.is_empty() { return Ok(json!(true)); }
        let result = patches.iter().try_for_each(|patch| {
            self.set_part_state(patch)?;
            // Keep the individual command's order of pending blasts and their effects.
            let mut effects = Effects::new(self.visual);
            self.apply_effects(core, &mut effects)
        });
        // A refused later patch leaves its predecessors written. Close their derived
        // readings before returning that same error, as well as on a complete batch.
        self.update_powertrains();
        self.refresh_sensors();
        result.map(|()| json!(true))
    }
    pub(super) fn command_damage(&mut self, core: &mut NativeWorld, op: &str, r: &Value) -> Result<Value, String> {
        let mut effects = Effects::new(self.visual);
        let owner = id(r, "owner");
        let p = Point::from_value(r.get("point").unwrap_or(r));
        match op {
            "explode" => {
                self.projectiles
                    .pending_blasts
                    .push_back(crate::game_projectiles::Blast {
                        point: p,
                        power: number(r, "power", 0.0),
                        radius: number(r, "radius", 1.0),
                        source: r["sourceOwner"].as_u64().map(|x| x as u32),
                        actor: None,
                        details: r["details"].clone(),
                    })
            }
            "setPartState" => self.set_part_state(r)?,
            "dent" => {
                if let Some(plate) = self.damage.plate_mut(owner) {
                    plate.record_dent(p, number(r, "depth", 0.0), number(r, "radius", 0.05));
                }
            }
            "impulse" => effects.impulse(owner, p, Point::from_value(&r["impulse"])),
            _ => {
                let removed = self.damage.cut(
                    owner,
                    Point::from_value(&r["start"]),
                    Point::from_value(&r["end"]),
                    number(r, "radius", 0.01),
                    &mut effects,
                );
                self.apply_effects(core, &mut effects)?;
                self.update_powertrains();
                self.refresh_sensors();
                return Ok(json!(!removed.is_empty()));
            }
        }
        self.apply_effects(core, &mut effects)?;
        self.update_powertrains();
        self.refresh_sensors();
        return Ok(json!(true));
    }
    pub(super) fn command_actor(&mut self, core: &mut NativeWorld, op: &str, r: &Value) -> Result<Value, String> {
        let index = self.actor_index(r)?;
        if self.actors[index].defeated
            && matches!(op, "control" | "aim" | "trigger" | "fire")
        {
            return Ok(json!(false));
        }
        let result = match op {
            "configureLauncher" => {
                let p = &r["point"];
                if !["x", "y"]
                    .iter()
                    .all(|k| p[*k].as_f64().is_some_and(|n| n.is_finite()))
                {
                    return Err("Invalid launcher point".into());
                }
                self.actors[index].launcher = Point::from_value(p);
                Ok(json!(true))
            }
            "control" => {
                let (throttle, brake) = self.tow_controls(self.actors[index].handle, number(r, "throttle", 0.0), Self::brake_share(r, 0.0)?);
                let a = &mut self.actors[index];
                if let Some(d) = &mut a.drive {
                    d.control(throttle, brake);
                    d.climb_asked(number(r, "rise", 0.0));
                    if let Some(enabled) = r["enabled"].as_bool() {
                        d.enabled = enabled;
                        if let Some(body) = core
                            .bodies
                            .get(&a.body)
                            .and_then(|h| core.world.bodies.get_mut(*h))
                        {
                            body.set_body_type(
                                if enabled {
                                    rapier2d_f64::prelude::RigidBodyType::Dynamic
                                } else {
                                    rapier2d_f64::prelude::RigidBodyType::Fixed
                                },
                                true,
                            );
                        }
                        // Fixed bodies zero velocity in Rapier; publish it at this boundary.
                        self.sync_poses(core);
                    }
                }
                Ok(json!(true))
            }
            "cancel" => {
                self.actors[index].pending = None;
                for e in &mut self.actors[index].also {
                    e.pending = None;
                }
                Ok(json!(true))
            }
            "aim" | "trigger" | "fire" => {
                if op == "trigger"
                    && r["active"] != true
                    && !r["aim"].is_object()
                    && !r["config"].is_object()
                {
                    self.actors[index].trigger = None;
                    for e in &mut self.actors[index].also {
                        e.held = false;
                    }
                    if let Some(defeated) = r["defeated"].as_bool() {
                        self.actors[index].defeated = defeated;
                    }
                    return Ok(json!(true));
                }
                let mut settings = self.settings(&r["config"], false)?;
                self.actors[index].also.clear();
                if r["config"]["componentId"].is_string() && settings.component.is_none() {
                    settings.component = Some(u32::MAX);
                }
                let aim = if r["aim"].is_object() {
                    Point::from_value(&r["aim"])
                } else {
                    self.actors[index].aim
                };
                self.update_aim(index, aim, &settings);
                self.advance_weapons(0.0, Some(self.actors[index].handle));
                match op {
                    "trigger" => {
                        self.actors[index].trigger = if r["active"] == true {
                            Some((aim, settings))
                        } else {
                            None
                        };
                        Ok(json!(true))
                    }
                    "fire" => Ok(json!(self.fire(core, index, aim, &settings, r["force"] == true)?)),
                    _ => Ok(json!(true)),
                }
            }
            "input" => self.input(core, index, &r["input"], r["force"] == true),
            _ => Err(format!("Unknown game operation {op}")),
        };
        if result.is_ok() {
            if let Some(defeated) = r["defeated"].as_bool() {
                self.actors[index].defeated = defeated;
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn world() -> NativeWorld {
        let scene = crate::game_damage::fixtures::stock_scene(
            &[(1, "local", "heavy", 0.0), (2, "supplier", "supply", 30.0)], json!("flat"));
        let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
        core.load_game(&scene.to_string()).unwrap();
        core
    }
    fn owner(core: &NativeWorld, actor: u32, kind: ComponentKind) -> u32 {
        core.game.as_ref().unwrap().damage.modules.iter().find(|m| m.actor == actor && m.kind == kind).unwrap().owner
    }
    #[test]
    fn repair_extinguishes_the_shared_fire_and_restores_only_the_repaired_material() {
        let mut core=world();
        let engine=owner(&core,1,ComponentKind::Engine);
        let tank=owner(&core,1,ComponentKind::Fuel);
        let game=core.game.as_mut().unwrap();
        for module in &mut game.damage.modules {
            if module.actor==1 {module.burning=true;module.burn_age=45.0;module.health=module.max_health*0.5;}
        }
        let litres=game.damage.module(tank).unwrap().fuel_litres;
        let maximum=game.damage.module(engine).unwrap().max_health;
        ask(&mut core,json!({"op":"setPartState","owner":engine,"state":{"health":maximum*0.75}}));
        let damage=&core.game.as_ref().unwrap().damage;
        assert!(damage.modules.iter().filter(|m|m.actor==1).all(|m|!m.burning));
        assert_eq!(damage.module(engine).unwrap().burn_age,22.5);
        assert_eq!(damage.module(tank).unwrap().burn_age,45.0);
        assert_eq!(damage.module(tank).unwrap().fuel_litres,litres);
        ask(&mut core,json!({"op":"setPartState","owner":engine,"state":{"health":maximum}}));
        assert_eq!(core.game.as_ref().unwrap().damage.module(engine).unwrap().burn_age,0.0);
    }
    fn ask(core: &mut NativeWorld, request: Value) -> Value {
        serde_json::from_str(&core.game_command(&request.to_string()).unwrap()).unwrap()
    }
    fn readings(core: &NativeWorld) -> Value {
        let game = core.game.as_ref().unwrap();
        json!({"modules":game.damage.modules.iter().map(Module::to_value).collect::<Vec<_>>(),
            "powertrains":game.actors.iter().map(|a|a.powertrain.to_value()).collect::<Vec<_>>(),
            "sensorModules":&game.sensor_modules,"sensorActors":&game.sensor_actors})
    }
    fn single(core: &mut NativeWorld, patch: &Value) -> Result<String, String> {
        core.game_command(&json!({"op":"setPartState","owner":patch["owner"],"state":patch["state"],"frame":false}).to_string())
    }
    fn same(core: &mut NativeWorld, reference: &mut NativeWorld) {
        assert_eq!(readings(core), readings(reference));
        assert_eq!(ask(core, json!({"op":"sync"})), ask(reference, json!({"op":"sync"})));
        assert_eq!(ask(core, json!({"op":"digest"})), ask(reference, json!({"op":"digest"})));
    }

    #[test]
    fn part_state_batches_match_individual_reserves_frames_physics_and_restore() {
        let (mut reference, mut batch) = (world(), world());
        let fuel = owner(&batch, 1, ComponentKind::Fuel);
        let ammo = owner(&batch, 1, ComponentKind::Ammo);
        let cargo = owner(&batch, 2, ComponentKind::Supply);
        let engine = owner(&batch, 1, ComponentKind::Engine);
        let command = owner(&batch, 1, ComponentKind::Command);
        let patches = json!([
            {"owner":fuel,"state":{"fuelLitres":1e9}},
            {"owner":ammo,"state":{"rounds":1e9}},
            {"owner":cargo,"state":{"cargo":{"ferro":1e9,"petroleo":1e9}}},
            {"owner":engine,"state":{"health":0}},
            {"owner":command,"state":{"health":0}},
            {"owner":fuel,"state":{"fuelLitres":23.75}},
            {"owner":ammo,"state":{"rounds":3.9}}
        ]);
        for patch in patches.as_array().unwrap() { single(&mut reference, patch).unwrap(); }
        let response = ask(&mut batch, json!({"op":"setPartStates","patches":patches,"frame":false}));
        assert_eq!(response["result"], true);
        assert!(response["frame"].is_null(), "the usual frame option applies to the entire batch");
        assert_eq!(batch.game.as_ref().unwrap().damage.module(fuel).unwrap().fuel_litres, 23.75);
        assert_eq!(batch.game.as_ref().unwrap().damage.module(ammo).unwrap().rounds, 3);
        same(&mut batch, &mut reference);
        // Cross the existing reserve-weighing phase: no eager weighing or changed physical threshold.
        for _ in 0..12 {
            let actual: Value = serde_json::from_str(&batch.game_step(1.0 / 60.0).unwrap()).unwrap();
            let expected: Value = serde_json::from_str(&reference.game_step(1.0 / 60.0).unwrap()).unwrap();
            assert_eq!(actual, expected);
            assert_eq!(batch.frame_block().unwrap(), reference.frame_block().unwrap());
        }
        same(&mut batch, &mut reference);
        let state = batch.export_state().unwrap();
        let mut restored = world();
        restored.import_state(&state).unwrap();
        same(&mut restored, &mut batch);
    }

    #[test]
    fn part_state_batches_keep_individual_pending_blast_drains() {
        let (mut reference, mut batch) = (world(), world());
        let fuel = owner(&batch, 1, ComponentKind::Fuel);
        let ammo = owner(&batch, 1, ComponentKind::Ammo);
        for core in [&mut reference, &mut batch] {
            for _ in 0..21 {
                core.game.as_mut().unwrap().projectiles.pending_blasts.push_back(crate::game_projectiles::Blast {
                    point: Point::new(0.0, 100.0), power: 1.0, radius: 1.0,
                    source: None, actor: None, details: json!({}),
                });
            }
        }
        let patches = json!([{"owner":fuel,"state":{"fuelLitres":0}}, {"owner":ammo,"state":{"rounds":0}}]);
        for patch in patches.as_array().unwrap() { single(&mut reference, patch).unwrap(); }
        assert!(reference.game.as_ref().unwrap().projectiles.pending_blasts.is_empty());
        assert_eq!(ask(&mut batch, json!({"op":"setPartStates","patches":patches,"frame":false}))["result"], true);
        assert!(batch.game.as_ref().unwrap().projectiles.pending_blasts.is_empty(),
            "each patch retains the individual command's twenty-blast drain");
        same(&mut batch, &mut reference);
    }

    #[test]
    fn part_state_batches_keep_the_valid_prefix_and_its_readings_on_each_error() {
        for problem in 0..4 {
            let (mut reference, mut batch) = (world(), world());
            let before = readings(&batch);
            let fuel = owner(&batch, 1, ComponentKind::Fuel);
            let ammo = owner(&batch, 1, ComponentKind::Ammo);
            let engine = owner(&batch, 1, ComponentKind::Engine);
            let command = owner(&batch, 1, ComponentKind::Command);
            let cargo = owner(&batch, 2, ComponentKind::Supply);
            let prefix = vec![json!({"owner":fuel,"state":{"fuelLitres":0}}),
                json!({"owner":engine,"state":{"health":0}}), json!({"owner":command,"state":{"health":0}})];
            for patch in &prefix { single(&mut reference, patch).unwrap(); }
            let bad = match problem {
                0 => json!({"owner":ammo,"state":{"rounds":-1}}),
                1 => json!({"owner":u32::MAX,"state":{"rounds":1}}),
                2 => json!({"owner":cargo,"state":{"cargo":{"unknown":1}}}),
                _ => json!({"owner":fuel,"state":false}),
            };
            let error = single(&mut reference, &bad).unwrap_err();
            let mut patches = prefix;
            patches.push(bad);
            patches.push(json!({"owner":ammo,"state":{"rounds":0}}));
            assert_eq!(batch.game_command(&json!({"op":"setPartStates","patches":patches,"frame":true}).to_string()).unwrap_err(), error);
            assert_ne!(readings(&batch)["powertrains"], before["powertrains"]);
            assert_ne!(readings(&batch)["sensorModules"], before["sensorModules"]);
            assert_eq!(batch.game.as_ref().unwrap().damage.module(ammo).unwrap().rounds,
                reference.game.as_ref().unwrap().damage.module(ammo).unwrap().rounds, "the patch after the error was not applied");
            same(&mut batch, &mut reference);
        }
    }

    #[test]
    fn tools_take_their_power_from_the_engines_of_their_construction_and_burn_its_fuel_for_it() {
        use crate::game_motion::fuel_flow;
        // The miner digs with 110 kW of its 180; the tanker pumps with 150 of its 240, and the construction truck
        // builds with 110 of its 400.
        let fresh = || {
            let scene = crate::game_damage::fixtures::stock_scene(
                &[(1, "miner", "mining-truck", 0.0), (2, "pump", "tanker", 40.0), (3, "crane", "construction-truck", 80.0)], json!("flat"));
            let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
            core.load_game(&scene.to_string()).unwrap();
            core
        };
        let fuel = |core: &NativeWorld, actor: u32| core.game.as_ref().unwrap().damage.modules.iter()
            .filter(|m| m.actor == actor && m.kind == ComponentKind::Fuel).map(|m| m.fuel_litres).sum::<f64>();
        let work = |core: &mut NativeWorld, actor: &str, tools: &[u32], seconds: f64| {
            let told = ask(core, json!({"op":"work","actorId":actor,"tools":tools,"seconds":seconds,"frame":false}));
            assert!(told["frame"].is_null());
            (told["result"]["share"].as_f64().unwrap(), told["result"]["limit"].as_str().map(str::to_owned))
        };
        let close = |a: f64, b: f64| assert!((a - b).abs() < 1e-9, "{a} against {b}");
        let mut core = fresh();
        let (excavator, drill) = (owner(&core, 1, ComponentKind::Excavator), owner(&core, 2, ComponentKind::Drill));
        let (miner, pump) = (fuel(&core, 1), fuel(&core, 2));
        assert_eq!(work(&mut core, "miner", &[excavator], 60.0), (1.0, None));
        close(miner - fuel(&core, 1), fuel_flow(110.0, 180.0) / 60.0);
        assert_eq!(work(&mut core, "pump", &[drill], 60.0), (1.0, None));
        close(pump - fuel(&core, 2), fuel_flow(150.0, 240.0) / 60.0);
        let (arm, crane) = (owner(&core, 3, ComponentKind::Builder), fuel(&core, 3));
        assert_eq!(work(&mut core, "crane", &[arm], 60.0), (1.0, None));
        close(crane - fuel(&core, 3), fuel_flow(110.0, 400.0) / 60.0);
        // A tool of another construction asks nothing of these engines, and a moment burns nothing.
        let (miner, pump) = (fuel(&core, 1), fuel(&core, 2));
        assert_eq!(work(&mut core, "pump", &[excavator], 60.0), (0.0, None));
        assert_eq!(work(&mut core, "miner", &[excavator], 0.0), (1.0, None));
        assert_eq!((fuel(&core, 1), fuel(&core, 2)), (miner, pump));
        // An engine at half its health gives 90 kW of the 110 asked: the excavator digs at that share of its pace, and
        // the engine burns for all it gives.
        let engine = owner(&core, 1, ComponentKind::Engine);
        let half = core.game.as_ref().unwrap().damage.module(engine).unwrap().max_health / 2.0;
        single(&mut core, &json!({"owner":engine,"state":{"health":half}})).unwrap();
        let (share, limit) = work(&mut core, "miner", &[excavator], 60.0);
        close(share, 90.0 / 110.0); assert_eq!(limit.as_deref(), Some("power"));
        close(miner - fuel(&core, 1), fuel_flow(90.0, 90.0) / 60.0);
        // No engine that turns, no fuel: nothing is done and nothing burned.
        single(&mut core, &json!({"owner":engine,"state":{"health":0}})).unwrap();
        let left = fuel(&core, 1);
        assert_eq!(work(&mut core, "miner", &[excavator], 60.0), (0.0, Some("engine".into())));
        assert_eq!(fuel(&core, 1), left);
        let tank = owner(&core, 2, ComponentKind::Fuel);
        single(&mut core, &json!({"owner":tank,"state":{"fuelLitres":0}})).unwrap();
        assert_eq!(work(&mut core, "pump", &[drill], 60.0), (0.0, Some("fuel".into())));
        // Fuel for half a minute of it lasts half that minute, and is all burned.
        single(&mut core, &json!({"owner":tank,"state":{"fuelLitres":fuel_flow(150.0, 240.0) / 120.0}})).unwrap();
        let (share, limit) = work(&mut core, "pump", &[drill], 60.0);
        close(share, 0.5); assert_eq!(limit.as_deref(), Some("fuel")); close(fuel(&core, 2), 0.0);
        // A destroyed tool asks nothing.
        single(&mut core, &json!({"owner":tank,"state":{"fuelLitres":100}})).unwrap();
        single(&mut core, &json!({"owner":drill,"state":{"health":0}})).unwrap();
        assert_eq!(work(&mut core, "pump", &[drill], 60.0), (0.0, None)); assert_eq!(fuel(&core, 2), 100.0);
        assert!(core.game_command(&json!({"op":"work","actorId":"pump","tools":[drill],"seconds":-1}).to_string()).is_err());
    }

    #[test]
    fn part_state_batches_admit_empty_and_reject_malformed_or_oversized_envelopes_without_writes() {
        let mut core = world();
        let before = readings(&core);
        let response = ask(&mut core, json!({"op":"setPartStates","patches":[],"frame":false}));
        assert_eq!(response["result"], true);
        assert!(response["frame"].is_null());
        for patches in [Value::Null, json!({}), json!(false)] {
            assert_eq!(core.game_command(&json!({"op":"setPartStates","patches":patches}).to_string()).unwrap_err(),
                "Part state patches must be an array");
        }
        let fuel = owner(&core, 1, ComponentKind::Fuel);
        let count = core.game.as_ref().unwrap().damage.modules.len();
        let patches = vec![json!({"owner":fuel,"state":{"fuelLitres":0}}); count + 1];
        assert_eq!(core.game_command(&json!({"op":"setPartStates","patches":patches}).to_string()).unwrap_err(),
            "Part state batch exceeds component count");
        assert_eq!(readings(&core), before);
    }
}
