//! Conservation and material-interface regressions for primary rounds and their spall.
use super::*;
use crate::game_damage::fixtures::{geometry as entity, module, plate};
use crate::game_geometry::EntityKind;

fn near(a: f64, b: f64) { assert!((a-b).abs() < 1e-7 * a.abs().max(b.abs()).max(1.0), "{a} != {b}"); }
fn add_plate(damage: &mut DamageState, geometry: &mut Geometry, owner: u32, actor: u32, value: Value) {
    damage.insert_plate(plate(owner, actor, &value));
    geometry.upsert(owner, entity(owner, actor, EntityKind::Plate, &value).unwrap());
}
fn add_engine(damage: &mut DamageState, geometry: &mut Geometry, owner: u32, x: f64) {
    let value = json!({"kind":"engine","x":x,"y":3,"width":0.3,"height":0.6,
        "physicalMass":5,"health":10000,"maxHealth":10000});
    damage.insert_module(module(owner, 7, &value));
    geometry.upsert(owner, entity(owner, 7, EntityKind::Module, &value).unwrap());
}
fn vertical(x: f64, thickness: f64, material: &str) -> Value {
    json!({"length":4,"thicknessMm":thickness*1000.0,"material":material,"x":x,"y":3,
        "angle":std::f64::consts::FRAC_PI_2})
}
fn primary(power: f64) -> Projectile {
    Projectile::from_value(&json!({"x":-1,"y":3,"vx":1650,"vy":0,"mass":5,"caliberMm":120,
        "power":power,"radius":0.06,"ammo":"apfsds","weapon":"cannon"})).unwrap()
}
fn heat(power:f64)->Projectile {
    Projectile::from_value(&json!({"x":-0.01,"y":3,"vx":300,"vy":0,"mass":2,"caliberMm":84,
        "power":power,"radius":0.01,"blastRadius":0.7,"ammo":"heat","weapon":"rocket"})).unwrap()
}
fn heat_contacts(plates:&[(f64,f64)],power:f64)->(Vec<Value>,Vec<Blast>) {
    let (mut damage,mut geometry)=(DamageState::default(),Geometry::new());
    for (i,&(x,gauge)) in plates.iter().enumerate() {add_plate(&mut damage,&mut geometry,i as u32+1,7,vertical(x,gauge,"steel"));}
    let mut p=heat(power);
    let mut state=ProjectileState::default();
    let mut effects=Effects::new(true);
    // Allies pay the same complete material chords without cutting the following target with spall first.
    state.move_projectile(&[], &mut p,|_| true,1.0/60.0,0.0,&mut damage,&mut geometry,&Terrain::new("flat").unwrap(),&mut effects);
    let contacts=effects.events.into_iter().filter(|event|
        event["fragment"]==false && matches!(event["type"].as_str(),Some("penetration"|"blocked"))).collect();
    (contacts,state.pending_blasts.into_iter().collect())
}

#[test]
fn a_twenty_millimetre_gap_spends_air_instead_of_the_paid_heat_chord() {
    for gap in [0.0,0.02,1.0] {
        let (contacts,blasts)=heat_contacts(&[(0.0575,0.115),(0.1725+gap,0.115)],300.0);
        assert_eq!(contacts.len(),2,"both real primary contacts must be reported, gap={gap}");
        assert_eq!(contacts[0]["type"],"penetration");
        assert_eq!(contacts[1]["type"],if gap<0.1 {"penetration"}else{"blocked"});
        assert_eq!(blasts.len(),1);assert_eq!(blasts[0].details["shaped"],true);
        if gap<0.1 {
            let kept=contacts[0]["remaining"].as_f64().unwrap();
            let entering=contacts[1]["power"].as_f64().unwrap();
            let air=-JET_REACH*ComplexField::ln(entering/kept);
            // Contact time is interpolated along a fixed-step flight chord; one millimetre is ample for that
            // numerical difference but cannot hide an additional 115 mm of already-paid material.
            assert!((air-gap).abs()<0.001,"gap={gap}, attenuation implies {air} m of air");
        }
    }
}

#[test]
fn heat_paid_transit_keeps_its_power_and_resumes_identically_mid_chord() {
    let (mut damage,mut geometry)=(DamageState::default(),Geometry::new());
    for (i,x) in [0.0575,0.1925].into_iter().enumerate() {add_plate(&mut damage,&mut geometry,i as u32+1,7,vertical(x,0.115,"steel"));}
    let terrain=Terrain::new("flat").unwrap();
    let mut state=ProjectileState::default();
    let mut effects=Effects::new(true);
    let mut p=heat(300.0);
    let dt=0.00001;
    let mut time=0.0;
    for _ in 0..20 {
        assert!(state.move_projectile(&[], &mut p,|_| true,dt,time,&mut damage,&mut geometry,&terrain,&mut effects));
        time+=dt;
        if !p.crossed_layers.is_empty() {break;}
    }
    assert!(p.point.x>0.0 && p.point.x<0.115 && p.visited==[1]);
    let kept=rows(&effects,"penetration")[0]["remaining"].as_f64().unwrap();
    assert_eq!(p.power,kept,"the first incomplete transit has no free air");
    assert!(state.move_projectile(&[], &mut p,|_| true,dt,time,&mut damage,&mut geometry,&terrain,&mut effects));
    time+=dt;
    assert!(p.point.x<0.115 && !p.crossed_layers.is_empty());
    assert_eq!(p.power,kept,"the next no-hit flight step is still inside paid metal");
    assert_eq!(state.pending_blasts.len(),1);
    let canonical=Drag::admit(p.mass,p.caliber_mm,"rocket",Some(p.drag.cd)).unwrap();
    assert_eq!(p.drag.per_meter.to_bits(),canonical.per_meter.to_bits(),"the converted jet must keep canonical flight metadata");
    let mut binary:Projectile=rmp_serde::from_slice(&rmp_serde::to_vec(&p).unwrap()).unwrap();
    let mut diagnostic=Projectile::from_value(&p.to_value()).unwrap();
    let damage_state=rmp_serde::to_vec(&damage).unwrap();
    let mut outcomes=Vec::new();
    for round in [&mut p,&mut binary,&mut diagnostic] {
        let mut d:DamageState=rmp_serde::from_slice(&damage_state).unwrap();
        let mut g=geometry.clone();
        let mut simulation=ProjectileState::default();
        let mut e=Effects::new(true);
        for step in 0..100 {
            assert!(simulation.move_projectile(&[], round,|_| true,dt,time+step as f64*dt,&mut d,&mut g,&terrain,&mut e));
            if round.visited.contains(&2) {break;}
        }
        assert!(round.visited.contains(&2),"the real second plate must be reached and penetrated");
        assert_eq!(rows(&e,"penetration").len(),1);
        assert!(simulation.pending_blasts.is_empty(),"continuation cannot repeat the first shaped burst");
        outcomes.push((round.point,round.velocity,round.power,e.events));
    }
    assert_eq!(outcomes[0],outcomes[1]);assert_eq!(outcomes[0],outcomes[2]);
}

#[test]
fn overlapping_paid_heat_chords_leave_the_real_following_air_gap() {
    // The first two real chords overlap by 60 mm. Their paid union ends at x=.22; the witness starts at x=.24.
    // Subtracting both chord lengths instead of their union would incorrectly exempt the 20 mm of actual air.
    let (contacts,blasts)=heat_contacts(&[(0.08,0.16),(0.16,0.12),(0.245,0.01)],600.0);
    assert_eq!(contacts.len(),3);assert!(contacts.iter().all(|event|event["type"]=="penetration"));
    near(contacts[0]["remaining"].as_f64().unwrap(),contacts[1]["power"].as_f64().unwrap());
    let kept=contacts[1]["remaining"].as_f64().unwrap();
    let entering=contacts[2]["power"].as_f64().unwrap();
    let air=-JET_REACH*ComplexField::ln(entering/kept);
    assert!((air-0.02).abs()<0.001,"the paid union must leave 20 mm of air, observed {air}");
    assert!(kept-entering>1.0,"the gap cannot disappear under a sum of overlapping paid lengths");
    assert_eq!(blasts.len(),1);
}
fn fly(p: &mut Projectile, damage: &mut DamageState, geometry: &mut Geometry, effects: &mut Effects) -> bool {
    let mut state = ProjectileState::default();
    let terrain = Terrain::new("flat").unwrap();
    for step in 0..120 {
        if !state.move_projectile(&[], p, |_| false, 1.0/240.0, step as f64/240.0, damage, geometry, &terrain, effects) {
            return false;
        }
        if p.point.x > 14.0 { return true; }
    }
    panic!("primary did not finish the material assay");
}
fn rows<'a>(effects: &'a Effects, kind: &str) -> Vec<&'a Value> {
    effects.events.iter().filter(|event| event["type"] == kind).collect()
}

#[test]
fn a_first_rh120_round_cannot_bore_five_metres_by_reusing_its_spall() {
    for (material, thickness) in [("concrete",1.0),("steel",0.144)] {
        let (mut damage, mut geometry) = (DamageState::default(), Geometry::new());
        for i in 0..5 { add_plate(&mut damage,&mut geometry,i+1,7,vertical(0.5+2.0*i as f64,thickness,material)); }
        add_engine(&mut damage,&mut geometry,6,10.0);
        let layers = geometry.raycast_layers(point(-1.0,3.0),point(12.0,3.0),&RayOptions { projectile:true,..Default::default() });
        near(layers.iter().filter(|h| h.kind == EntityKind::Plate).map(|h|strike_cost(&damage,h,1.0).1).sum(),900.0);
        let mut p = primary(430.0);
        let mut effects = Effects::new(true);
        assert!(!fly(&mut p,&mut damage,&mut geometry,&mut effects),"{material}: no surviving primary");
        assert_eq!(damage.module(6).unwrap().health,10000.0,"{material}: mechanisms behind the barrier are untouched");
        assert!(rows(&effects,"blocked").iter().any(|e|e["owner"] == 3),"{material}: the third full chord stops it");
        let rays = rows(&effects,"secondary-ray");
        assert!(!rays.is_empty(),"a real free rear face still emits fragments");
        for ray in rays {
            assert!(ray["powerBudget"].as_f64().unwrap() <= 180.0*0.08*0.5+1e-8);
            assert!(ray["powerSpent"].as_f64().unwrap() <= ray["powerBudget"].as_f64().unwrap()+1e-8);
            assert!(ray["energySpent"].as_f64().unwrap() <= ray["energyBudget"].as_f64().unwrap()+1e-8);
        }
    }
}

#[test]
fn subdividing_continuous_concrete_or_thin_steel_creates_no_internal_spall_face() {
    for (material, thickness, count, power) in [("concrete",1.0,5,430.0),("steel",0.001,40,30.0)] {
        let mut results = Vec::new();
        for split in [false,true] {
            for across_actors in [false,true] {
                let (mut damage,mut geometry) = (DamageState::default(),Geometry::new());
                let n = if split {count} else {1};
                let gauge = if split {thickness} else {thickness*count as f64};
                for i in 0..n {
                    let actor = if across_actors && i%2 == 1 {8} else {7};
                    add_plate(&mut damage,&mut geometry,i+1,actor,vertical((i as f64+0.5)*gauge,gauge,material));
                }
                add_engine(&mut damage,&mut geometry,n+1,thickness*count as f64+1.0);
                let mut p = primary(power);
                let mut effects = Effects::new(true);
                let escaped = fly(&mut p,&mut damage,&mut geometry,&mut effects);
                assert!(rows(&effects,"secondary-ray").is_empty(),"{material}, split={split}, actors={across_actors}: a seam is not open air");
                results.push((escaped,p.power,damage.module(n+1).unwrap().health));
            }
        }
        assert!(results.iter().all(|result| *result == results[0]),"{material}: {results:?}");
        assert_eq!(results[0],(false,0.0,10000.0));
    }
}

#[test]
fn spall_inherits_energy_and_power_and_does_not_skip_a_one_millimetre_skin() {
    let (mut damage,mut geometry) = (DamageState::default(),Geometry::new());
    add_plate(&mut damage,&mut geometry,1,7,vertical(0.0,0.05,"steel"));
    add_plate(&mut damage,&mut geometry,2,7,vertical(0.0265,0.001,"steel"));
    let mut p = primary(430.0);
    let hit = geometry.raycast(p.point,point(1.0,3.0),&RayOptions{complete_exit:true,projectile:true,..Default::default()}).unwrap();
    let cost = strike_cost(&damage,&hit,1.0).1;
    let energy = 0.5*p.mass*dot(p.velocity,p.velocity);
    let mut effects = Effects::new(true);
    let result = ProjectileState::default().resolve_impact(&[], &hit,&mut p,point(1.0,0.0),false,
        &mut damage,&mut geometry,&Terrain::new("flat").unwrap(),&mut effects,0.0);
    assert!(result == ImpactResult::Penetration);
    let rays = rows(&effects,"secondary-ray");
    assert_eq!(rays.len(),3);
    near(rays.iter().map(|r|r["powerBudget"].as_f64().unwrap()).sum(),cost*0.08);
    near(rays.iter().map(|r|r["energyBudget"].as_f64().unwrap()).sum(),energy*cost/430.0*0.08);
    let primary = rows(&effects,"penetration").into_iter().find(|event|event["owner"] == 1).unwrap();
    near(primary["energyDeposited"].as_f64().unwrap()+primary["spallTransfer"]["released"]["energy"].as_f64().unwrap(),energy*cost/430.0);
    near(primary["spallTransfer"]["released"]["power"].as_f64().unwrap(),cost*0.08);
    assert!(rows(&effects,"secondary-impact").iter().any(|event|event["owner"] == 2),
        "the 1 mm plate, 1 mm beyond the rear face, must be intersected rather than skipped by an offset");
}

#[test]
fn fragment_contacts_deposit_only_the_energy_paid_here_and_keep_the_inherited_ratio() {
    for budget in [RayBudget::blast(20000.0),RayBudget{energy:100000.0,power:100.0},RayBudget{energy:100000.0,power:1.0}] {
        let (mut damage,mut geometry) = (DamageState::default(),Geometry::new());
        add_engine(&mut damage,&mut geometry,1,0.7);
        add_engine(&mut damage,&mut geometry,2,1.5);
        let hit = geometry.raycast(point(0.0,3.0),point(3.0,3.0),&RayOptions{complete_exit:true,..Default::default()}).unwrap();
        let cost = strike_cost(&damage,&hit,1.0).1;
        let deposited = budget.energy*(cost/budget.power).min(1.0);
        let expected_damage = damage.module(1).unwrap().strike_damage(hit.point,deposited/SECONDARY_ENERGY_PER_POWER,budget.power>=cost);
        let mut effects = Effects::new(true);
        let spent = ProjectileState::default().trace_damage_ray(&[], point(0.0,3.0),point(1.0,0.0),budget,
            3.0,None,Some(7),&[],&mut damage,&mut geometry,&Terrain::new("flat").unwrap(),&mut effects,0.0);
        near(10000.0-damage.module(1).unwrap().health,expected_damage);
        let contacts = rows(&effects,"secondary-impact");
        let ray = rows(&effects,"secondary-ray")[0];
        near(contacts.iter().map(|e|e["energyDeposited"].as_f64().unwrap()).sum(),spent);
        near(contacts.iter().map(|e|e["powerSpent"].as_f64().unwrap()).sum(),ray["powerSpent"].as_f64().unwrap());
        assert!(spent>0.0 && spent<=budget.energy);
        for contact in contacts {
            near(contact["energyDeposited"].as_f64().unwrap()/contact["powerSpent"].as_f64().unwrap(),budget.energy/budget.power);
        }
        if budget.power<cost {assert_eq!(damage.module(2).unwrap().health,10000.0);}
    }
}

#[test]
fn a_secondary_ricochet_reports_actual_energy_loss_separately_from_power_loss() {
    let (mut damage,mut geometry) = (DamageState::default(),Geometry::new());
    add_plate(&mut damage,&mut geometry,1,7,json!({"length":2,"thicknessMm":100,"material":"steel","x":0,"y":3}));
    let mut effects = Effects::new(true);
    let budget = RayBudget{energy:10000.0,power:10.0};
    let spent = ProjectileState::default().trace_damage_ray(&[], point(-1.1,3.06),point(1.0,-0.02),budget,
        3.0,None,None,&[],&mut damage,&mut geometry,&Terrain::new("flat").unwrap(),&mut effects,0.0);
    let contact = rows(&effects,"secondary-impact")[0];
    assert_eq!(contact["result"],"ricochet");
    let ray = rows(&effects,"secondary-ray")[0];
    near(spent,budget.energy*(1.0-RICOCHET_SPEED*RICOCHET_SPEED));
    near(ray["powerSpent"].as_f64().unwrap(),budget.power*(1.0-RICOCHET_POWER));
    near(contact["energyDeposited"].as_f64().unwrap(),spent);
    assert!((spent/budget.energy-ray["powerSpent"].as_f64().unwrap()/budget.power).abs()>0.05);
}

#[test]
fn a_perforating_primary_pays_every_thin_layer_even_when_the_gaps_are_below_six_millimetres() {
    for gap in [0.0,0.001,0.003] {
        let (mut damage,mut geometry) = (DamageState::default(),Geometry::new());
        for i in 0..8 {add_plate(&mut damage,&mut geometry,i+1,7,vertical((i as f64)*(0.001+gap),0.001,"steel"));}
        let mut p = primary(430.0);
        let mut effects = Effects::new(true);
        assert!(fly(&mut p,&mut damage,&mut geometry,&mut effects));
        let contacts = rows(&effects,"penetration");
        assert_eq!(contacts.len(),8,"gap={gap}: every physical sheet is encountered: {contacts:?}");
        for contact in &contacts {near(contact["powerSpent"].as_f64().unwrap(),1.25);}
        near(contacts.iter().map(|e|e["powerSpent"].as_f64().unwrap()).sum(),10.0);
    }
}

#[test]
fn a_perforated_continuous_solid_releases_the_same_complete_spall_budget_after_subdivision() {
    let mut results = Vec::new();
    for count in [1,5,10] {
        let (mut damage,mut geometry) = (DamageState::default(),Geometry::new());
        let gauge = 0.05/count as f64;
        for i in 0..count {add_plate(&mut damage,&mut geometry,i+1,7,vertical((i as f64+0.5)*gauge,gauge,"steel"));}
        let mut p = primary(430.0);
        let mut effects = Effects::new(true);
        assert!(fly(&mut p,&mut damage,&mut geometry,&mut effects));
        assert!(p.pending_spall.is_none());
        let rays = rows(&effects,"secondary-ray");
        assert_eq!(rays.len(),3,"{count}: only the actual rear face releases fragments");
        let power: f64 = rays.iter().map(|e|e["powerBudget"].as_f64().unwrap()).sum();
        let energy: f64 = rays.iter().map(|e|e["energyBudget"].as_f64().unwrap()).sum();
        near(power,5.0);
        results.push((power,energy));
    }
    for result in &results {near(result.0,results[0].0);near(result.1,results[0].1);}
}

#[test]
fn pending_spall_and_paid_transit_survive_binary_and_diagnostic_readmission_mid_chord() {
    let (mut damage,mut geometry) = (DamageState::default(),Geometry::new());
    for i in 0..2 {add_plate(&mut damage,&mut geometry,i+1,7,vertical((i as f64+0.5)*0.5,0.5,"concrete"));}
    let mut p = primary(430.0);
    let mut state = ProjectileState::default();
    let terrain = Terrain::new("flat").unwrap();
    let mut effects = Effects::new(true);
    // Enter the first chord, pay it, and stop before its rear face.
    assert!(state.move_projectile(&[], &mut p,|_| false,0.0007,0.0,&mut damage,&mut geometry,&terrain,&mut effects));
    assert!(p.pending_spall.is_some() && !p.crossed_layers.is_empty());
    assert!(p.point.x>0.0 && p.point.x<0.5);
    assert!(rows(&effects,"secondary-ray").is_empty());
    let binary = rmp_serde::to_vec(&p).unwrap();
    let mut restored: Projectile = rmp_serde::from_slice(&binary).unwrap();
    let mut from_json = Projectile::from_value(&p.to_value()).unwrap();
    let damage_state = rmp_serde::to_vec(&damage).unwrap();
    let mut outputs = Vec::new();
    for round in [&mut p,&mut restored,&mut from_json] {
        let (mut d,mut g): (DamageState,Geometry) = (rmp_serde::from_slice(&damage_state).unwrap(),geometry.clone());
        let mut e = Effects::new(true);
        assert!(fly(round,&mut d,&mut g,&mut e));
        let rays = rows(&e,"secondary-ray");
        assert_eq!(rays.len(),3);
        near(rays.iter().map(|ray|ray["powerBudget"].as_f64().unwrap()).sum(),180.0*0.08);
        outputs.push((round.point,round.velocity,round.power,e.events));
    }
    assert_eq!(outputs[0].0,outputs[1].0);assert_eq!(outputs[0].0,outputs[2].0);
    assert_eq!(outputs[0].1,outputs[1].1);assert_eq!(outputs[0].1,outputs[2].1);
    assert_eq!(outputs[0].2,outputs[1].2);assert_eq!(outputs[0].2,outputs[2].2);
    assert_eq!(outputs[0].3,outputs[1].3);assert_eq!(outputs[0].3,outputs[2].3);
}

#[test]
fn leaving_one_region_still_queries_the_complete_later_region_of_the_same_owner() {
    let value = json!({"kind":"engine","x":0,"y":3,"width":2,"height":1,"physicalMass":5});
    let mut shape = entity(1,7,EntityKind::Module,&value).unwrap();
    shape.polygons = [(-1.0,-0.2),(0.2,1.0)].into_iter().map(|(lo,hi)|
        vec![point(lo,-0.5),point(hi,-0.5),point(hi,0.5),point(lo,0.5)]).collect();
    let mut geometry = Geometry::new();
    geometry.upsert(1,shape);
    let hit = geometry.raycast(point(-0.2,3.0),point(0.4,3.0),&RayOptions{complete_exit:true,..Default::default()}).unwrap();
    near(hit.point.x,0.2);near(hit.exit_point.x,1.0);near(hit.depth,0.8);
}

#[test]
fn a_paid_region_does_not_make_a_disconnected_region_of_the_same_owner_immune_next_step() {
    let value = json!({"kind":"engine","x":1.25,"y":3,"width":2.5,"height":1,
        "physicalMass":5,"health":10000,"maxHealth":10000});
    let mut damage = DamageState::default();
    damage.insert_module(module(1,7,&value));
    let mut shape = entity(1,7,EntityKind::Module,&value).unwrap();
    shape.polygons = [(-1.25,-0.25),(0.25,1.25)].into_iter().map(|(lo,hi)|
        vec![point(lo,-0.5),point(hi,-0.5),point(hi,0.5),point(lo,0.5)]).collect();
    let mut geometry = Geometry::new();geometry.upsert(1,shape);
    let mut p = primary(430.0);
    let mut state = ProjectileState::default();
    let mut effects = Effects::new(true);
    let terrain = Terrain::new("flat").unwrap();
    assert!(state.move_projectile(&[], &mut p,|_| false,0.0009,0.0,&mut damage,&mut geometry,&terrain,&mut effects));
    assert!(p.point.x>0.0 && p.point.x<1.0);
    assert_eq!(rows(&effects,"penetration").len(),1);
    assert!(state.move_projectile(&[], &mut p,|_| false,0.0015,0.0009,&mut damage,&mut geometry,&terrain,&mut effects));
    assert!(p.point.x>2.5);
    assert_eq!(rows(&effects,"penetration").len(),2,"both disconnected regions spend their own material chord");
}

#[test]
fn an_oblique_multi_step_perforation_keeps_the_full_contiguous_transfer() {
    let (mut damage,mut geometry) = (DamageState::default(),Geometry::new());
    for i in 0..2 {add_plate(&mut damage,&mut geometry,i+1,7,vertical(i as f64+0.5,1.0,"concrete"));}
    let mut p = primary(430.0);
    p.point.y = 2.0;
    p.velocity = point(1650.0*cos(std::f64::consts::PI/6.0),1650.0*sin(std::f64::consts::PI/6.0));
    let mut state = ProjectileState::default();
    let terrain = Terrain::new("flat").unwrap();
    let mut effects = Effects::new(true);
    assert!(state.move_projectile(&[], &mut p,|_| false,0.001,0.0,&mut damage,&mut geometry,&terrain,&mut effects));
    assert!(p.pending_spall.is_some() && p.point.x>0.0 && p.point.x<1.0);
    for step in 0..30 {
        assert!(state.move_projectile(&[], &mut p,|_| false,0.0007,0.001+step as f64*0.0007,
            &mut damage,&mut geometry,&terrain,&mut effects));
        if p.point.x>3.0 {break;}
    }
    let primary: f64 = rows(&effects,"penetration").iter().map(|event|event["powerSpent"].as_f64().unwrap()).sum();
    let emitted: f64 = rows(&effects,"secondary-ray").iter().map(|event|event["powerBudget"].as_f64().unwrap()).sum();
    near(emitted,primary*0.08);
}

#[test]
fn removing_the_adjacent_material_cancels_a_pending_transfer_when_the_round_reaches_air() {
    let (mut damage,mut geometry) = (DamageState::default(),Geometry::new());
    for i in 0..2 {add_plate(&mut damage,&mut geometry,i+1,7,vertical((i as f64+0.5)*0.5,0.5,"concrete"));}
    let mut p = primary(430.0);
    let mut state = ProjectileState::default();
    let mut effects = Effects::new(true);
    assert!(state.move_projectile(&[], &mut p,|_| false,0.0007,0.0,&mut damage,&mut geometry,
        &Terrain::new("flat").unwrap(),&mut effects));
    assert!(p.pending_spall.is_some());
    geometry.remove(2);
    assert!(fly(&mut p,&mut damage,&mut geometry,&mut effects));
    assert!(p.pending_spall.is_none(),"an obsolete interface cannot retain a live budget in free air");
    assert!(rows(&effects,"secondary-ray").is_empty());
}

#[test]
fn the_ally_forecast_charges_disconnected_regions_as_the_live_round_does() {
    let fixture = |separate_owners| {
        let (mut damage,mut geometry) = (DamageState::default(),Geometry::new());
        let values = if separate_owners {
            vec![json!({"x":0.5,"y":3,"length":1,"thicknessMm":200,"material":"steel"}),
                json!({"x":2.5,"y":3,"length":1,"thicknessMm":200,"material":"steel"})]
        } else {
            // One damaged plate with two intact islands, not a second owner
            // standing in for the later material of the same original plate.
            vec![json!({"x":1.5,"y":3,"length":3,"thicknessMm":200,"material":"steel",
                "solidRegions":[{"minX":-1.5,"maxX":-0.5,"minY":-0.1,"maxY":0.1},
                    {"minX":0.5,"maxX":1.5,"minY":-0.1,"maxY":0.1}]})]
        };
        for (i,value) in values.into_iter().enumerate() {
            let plate = plate(i as u32+1,7,&value);
            geometry.upsert(plate.owner,crate::game_geometry::EntityGeometry::from_plate(&plate));
            damage.insert_plate(plate);
        }
        (damage,geometry)
    };
    let terrain = Terrain::new("flat").unwrap();
    let near_actor = Bounds {min_x:0.0,max_x:3.0,min_y:2.9,max_y:3.1};
    let mut reports = Vec::new();
    for dt in [0.004,0.0009] {
        for separate in [false,true] {
            let (mut damage,mut geometry) = fixture(separate);
            let mut round = primary(4000.0);
            round.drag = Drag {per_meter:0.0,cd:0.0};
            let line = LineOfFire {gun:99,point:round.point,velocity:round.velocity,drag:round.drag,
                ammo:round.ammo,power:round.power};
            let forecast = through(&[], &line,7,near_actor,0.006,dt,&damage,&geometry,&terrain).unwrap();
            assert!((forecast-0.375).abs()<1e-6,"separate={separate}, dt={dt}: {forecast}");
            assert_eq!(line_of_fire(&[], &line,0.006,(99,Bounds {min_x:-3.0,max_x:-2.0,min_y:2.9,max_y:3.1}),
                &[(7,near_actor)],dt,&damage,&geometry,&terrain),Line::Ally,
                "the second island leaves too little power to justify firing through an ally");
            let mut state = ProjectileState::default();
            let mut effects = Effects::new(true);
            for step in 0..20 {
                assert!(state.move_projectile(&[], &mut round,|actor| actor == 7,dt,step as f64*dt,
                    &mut damage,&mut geometry,&terrain,&mut effects));
                if round.point.x>3.0 {break;}
            }
            assert!(round.point.x>3.0);
            let contacts = rows(&effects,"penetration");
            assert_eq!(contacts.len(),2,"both actual material islands are charged");
            near(contacts.iter().map(|event|event["powerSpent"].as_f64().unwrap()).sum(),2500.0);
            assert!((forecast-round.power/line.power).abs()<1e-6,
                "forecast={forecast}, flown={}",round.power/line.power);
            reports.push(forecast);
        }
    }
    assert!((reports[0]-reports[1]).abs()<1e-10);
    assert!((reports[2]-reports[3]).abs()<1e-10);
}

#[test]
fn paid_origins_survive_world_local_rounding_without_skipping_a_one_millimetre_gap() {
    for x in [0.0,30.0,25000.0] {
        let mut geometry = Geometry::new();
        let thin = plate(1,7,&json!({"x":x,"y":2.2,"length":1,"angle":std::f64::consts::FRAC_PI_2,
            "thicknessMm":5,"material":"steel"}));
        geometry.upsert(1,crate::game_geometry::EntityGeometry::from_plate(&thin));
        let (start,end) = (point(x+4.16673580975535,2.6708044819872003),point(x-1.0,2.6667));
        let hit = geometry.raycast(start,end,&RayOptions{projectile:true,complete_exit:true,..Default::default()}).unwrap();
        let paid = RayOptions{projectile:true,complete_exit:true,paid_initial:&[1],..Default::default()};
        assert!(geometry.raycast(hit.point,end,&paid).is_none(),"the already-paid 5 mm chord is not charged twice at {x}");

        let islands = plate(1,7,&json!({"x":x,"y":2.2,"length":1,"angle":std::f64::consts::FRAC_PI_2,
            "thicknessMm":16,"material":"steel","solidRegions":[
                {"minX":-0.5,"maxX":0.5,"minY":-0.008,"maxY":-0.003},
                {"minX":-0.5,"maxX":0.5,"minY":-0.002,"maxY":0.003}]}));
        geometry.upsert(1,crate::game_geometry::EntityGeometry::from_plate(&islands));
        let (start,end) = (point(x+1.0,2.3),point(x-1.0,2.3));
        let first = geometry.raycast(start,end,&RayOptions{projectile:true,complete_exit:true,..Default::default()}).unwrap();
        near(first.depth,0.005);
        for origin in [first.point,first.exit_point] {
            let second = geometry.raycast(origin,end,&paid).unwrap();
            near(first.exit_point.x-second.point.x,0.001);
            near(second.depth,0.005);
        }
    }
}
