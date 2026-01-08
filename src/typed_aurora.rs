#[cfg(feature = "server")]
pub mod typed_aurora {
    pub trait TypedDocument<T: for<'a> serde::Deserialize<'a>> {
        fn into_type(self) -> Result<T, serde_json::Error>;
    }

    impl<T: for<'a> serde::Deserialize<'a>> TypedDocument<T> for aurora_db::Document {
        fn into_type(self) -> Result<T, serde_json::Error> {
            let json = aurora_db::network::http_models::document_to_json(&self);
            serde_json::from_value(json)
        }
    }

    pub fn into_insert_data<T: serde::Serialize>(
        document: T,
    ) -> Result<std::collections::HashMap<String, aurora_db::Value>, aurora_db::AuroraError> {
        let json = serde_json::to_value(document)?;
        aurora_db::network::http_models::json_to_insert_data(json)
    }
}
