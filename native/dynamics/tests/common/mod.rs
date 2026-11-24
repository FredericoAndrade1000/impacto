#![allow(dead_code)]
//! Fresh current fixtures, not readers or converters of archived snapshots.
use serde_json::{Value,json};

pub fn catalogue()->Value {
    serde_json::from_str(include_str!("../../../construction-catalogue.json")).unwrap()
}
pub fn material_plate(owner:u32,actor:u32,definition:Value,vertices:&[[f64;2]],indices:&[u32])->Value {
    let length=definition["length"].as_f64().unwrap();
    let thickness=definition["thicknessMm"].as_f64().unwrap()/1000.0;
    let min_x=vertices.iter().map(|v|v[0]).fold(f64::INFINITY,f64::min);
    let max_x=vertices.iter().map(|v|v[0]).fold(f64::NEG_INFINITY,f64::max);
    let min_y=vertices.iter().map(|v|v[1]).fold(f64::INFINITY,f64::min);
    let max_y=vertices.iter().map(|v|v[1]).fold(f64::NEG_INFINITY,f64::max);
    let nx=(((max_x-min_x)/0.02).ceil() as usize).clamp(1,256);
    let mut value=json!({"owner":owner,"actor":actor,"id":format!("plate-{owner}"),"definition":definition,
        "vertices":vertices.iter().map(|v|json!({"x":v[0],"y":v[1]})).collect::<Vec<_>>(),
        "uvs":vertices.iter().flat_map(|v|[0.5+v[0]/length,0.5-v[1]/thickness]).collect::<Vec<_>>(),
        "indices":indices,"ballisticGrid":{"version":1,"nx":nx,"ny":16,"bits":"ff".repeat(nx*2),
            "bounds":{"minX":min_x,"maxX":max_x,"minY":min_y,"maxY":max_y}}});
    if let Some(id)=value["definition"].get("id") {value["id"]=id.clone();}
    for key in ["physicalMass","physicalInertia","physicalCenterLocal"] {
        if let Some(v)=value["definition"].get(key) {value[key]=v.clone();}
    }
    value
}
pub fn rectangle_plate(owner:u32,actor:u32,definition:Value)->Value {
    let x=definition["length"].as_f64().unwrap()/2.0;
    let y=definition["thicknessMm"].as_f64().unwrap()/2000.0;
    material_plate(owner,actor,definition,&[[-x,-y],[x,-y],[x,y],[-x,y]],&[0,1,2,0,2,3])
}
