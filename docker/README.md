# Prerequisite
## Generate Key
openssl genrsa -out private.pem
openssl req -new -key private.pem -out csr.pem
openssl x509 -req -days 9999 -in csr.pem -signkey private.pem -out public.crt
rm csr.pem

# Run Server
docker-compose up -d
